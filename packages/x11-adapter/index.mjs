import { createRequire } from "node:module";
import { createDebugLogger } from "../protocol/debug.mjs";

const require = createRequire(import.meta.url);
const x11 = require("x11");
const keysyms = require("x11/lib/keysyms");

const DOM_CODE_TO_KEYSYM = {
  Backspace: keysyms.XK_BackSpace.code,
  Tab: keysyms.XK_Tab.code,
  Enter: keysyms.XK_Return.code,
  Escape: keysyms.XK_Escape.code,
  Delete: keysyms.XK_Delete.code,
  Home: keysyms.XK_Home.code,
  End: keysyms.XK_End.code,
  PageUp: keysyms.XK_Page_Up.code,
  PageDown: keysyms.XK_Page_Down.code,
  ArrowLeft: keysyms.XK_Left.code,
  ArrowUp: keysyms.XK_Up.code,
  ArrowRight: keysyms.XK_Right.code,
  ArrowDown: keysyms.XK_Down.code,
  ShiftLeft: keysyms.XK_Shift_L.code,
  ShiftRight: keysyms.XK_Shift_R.code,
  ControlLeft: keysyms.XK_Control_L.code,
  ControlRight: keysyms.XK_Control_R.code,
  AltLeft: keysyms.XK_Alt_L.code,
  AltRight: keysyms.XK_Alt_R.code,
  MetaLeft: keysyms.XK_Super_L.code,
  MetaRight: keysyms.XK_Super_R.code,
  Space: 32,
};

for (let index = 1; index <= 12; index += 1) {
  DOM_CODE_TO_KEYSYM[`F${index}`] = keysyms[`XK_F${index}`].code;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function queryExtension(X, name) {
  return new Promise((resolve, reject) => {
    X.QueryExtension(name, (error, info) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(info);
    });
  });
}

function requireExtension(X, name) {
  return new Promise((resolve, reject) => {
    X.require(name, (error, ext) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(ext);
    });
  });
}

function getGeometry(X, drawable) {
  return new Promise((resolve, reject) => {
    X.GetGeometry(drawable, (error, geometry) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(geometry);
    });
  });
}

function getImage(X, drawable, x, y, width, height) {
  return new Promise((resolve, reject) => {
    X.GetImage(2, drawable, x, y, width, height, 0xffffffff, (error, image) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(image);
    });
  });
}

function getKeyboardMapping(X, minKeycode, maxKeycode) {
  return new Promise((resolve, reject) => {
    X.GetKeyboardMapping(minKeycode, maxKeycode - minKeycode, (error, mapping) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(mapping);
    });
  });
}

function internAtom(X, name) {
  return new Promise((resolve, reject) => {
    X.InternAtom(false, name, (error, atom) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(atom);
    });
  });
}

function getSelectionOwner(X, selection) {
  return new Promise((resolve, reject) => {
    X.GetSelectionOwner(selection, (error, owner) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(owner);
    });
  });
}

function getProperty(X, wid, name, type = 0, remove = 0, longOffset = 0, longLength = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    X.GetProperty(remove ? 1 : 0, wid, name, type, longOffset, longLength, (error, property) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(property);
    });
  });
}

function bufferToUInt32Array(value) {
  const buffer = Buffer.from(value || []);
  const items = [];
  for (let index = 0; index + 4 <= buffer.length; index += 4) {
    items.push(buffer.readUInt32LE(index));
  }
  return items;
}

function decodePropertyText(property) {
  return Buffer.from(property?.data || [])
    .toString("utf8")
    .replace(/\0+$/g, "");
}

function decodeWmClass(property) {
  const parts = decodePropertyText(property)
    .split("\0")
    .filter(Boolean);

  return {
    instanceName: parts[0] || "",
    className: parts[1] || parts[0] || "",
  };
}

export class X11Adapter {
  constructor(options = {}) {
    this.options = options;
    this.log = createDebugLogger("x11", options.debug);
    this.display = null;
    this.X = null;
    this.root = null;
    this.screen = null;
    this.xtest = null;
    this.keyboardMap = new Map();
    this.atomCache = new Map();
    this.shmAvailable = false;
    this.connected = false;
    this.selectionWindow = null;
    this.pendingClipboardRequest = null;
    this.boundEventHandler = null;
  }

  async connect(displayName) {
    const deferred = createDeferred();
    const client = x11.createClient({ display: displayName }, (error, display) => {
      if (error) {
        deferred.reject(error);
        return;
      }
      deferred.resolve(display);
    });

    this.display = await deferred.promise;
    this.X = this.display.client;
    this.screen = this.display.screen[0];
    this.root = this.screen.root;
    this.shmAvailable = await this.probeShm();
    this.xtest = await requireExtension(this.X, "xtest").catch(() => null);
    await this.loadKeyboardMap();
    this.selectionWindow = this.X.AllocID();
    this.X.CreateWindow(this.selectionWindow, this.root, 0, 0, 1, 1);
    this.boundEventHandler = (event) => {
      void this.handleXEvent(event);
    };
    this.X.on("event", this.boundEventHandler);
    this.log("connected", displayName, { shmAvailable: this.shmAvailable, xtestAvailable: Boolean(this.xtest) });

    this.connected = true;
    client.on("error", () => {});
  }

  async disconnect() {
    if (this.pendingClipboardRequest) {
      clearTimeout(this.pendingClipboardRequest.timer);
      this.pendingClipboardRequest.reject(new Error("clipboard-disconnected"));
      this.pendingClipboardRequest = null;
    }

    if (this.boundEventHandler && this.X?.off) {
      this.X.off("event", this.boundEventHandler);
    }

    this.X?.terminate();
    this.log("disconnected");
    this.connected = false;
    this.display = null;
    this.X = null;
    this.screen = null;
    this.root = null;
    this.xtest = null;
    this.keyboardMap.clear();
    this.atomCache.clear();
    this.selectionWindow = null;
    this.boundEventHandler = null;
  }

  async getScreenInfo() {
    const geometry = await getGeometry(this.X, this.root);
    const rootDepth = this.screen.root_depth;
    const format = this.display.format?.[rootDepth] || { bits_per_pixel: 32 };

    return {
      width: geometry.width,
      height: geometry.height,
      depth: rootDepth,
      bitsPerPixel: format.bits_per_pixel,
      byteOrder: this.display.image_byte_order === 0 ? "LSBFirst" : "MSBFirst",
    };
  }

  async isShmAvailable() {
    return this.shmAvailable;
  }

  async captureFrame() {
    const info = await this.getScreenInfo();
    const image = await getImage(this.X, this.root, 0, 0, info.width, info.height);
    this.log("capture-frame", info.width, info.height);

    return {
      width: info.width,
      height: info.height,
      stride: info.width * 4,
      pixelFormat: "bgra8888",
      data: new Uint8Array(image.data),
    };
  }

  async captureTile(x, y, width, height) {
    const image = await getImage(this.X, this.root, x, y, width, height);
    this.log("capture-tile", x, y, width, height);
    return {
      width,
      height,
      stride: width * 4,
      pixelFormat: "bgra8888",
      data: new Uint8Array(image.data),
    };
  }

  async injectPointerMove(x, y) {
    this.ensureInputAvailable();
    this.xtest.FakeInput(this.xtest.MotionNotify, 0, 0, this.root, x, y);
    this.log("pointer-move", x, y);
  }

  async injectPointerButton(button, isDown) {
    this.ensureInputAvailable();
    const x11Button = button + 1;
    this.xtest.FakeInput(isDown ? this.xtest.ButtonPress : this.xtest.ButtonRelease, x11Button, 0, this.root, 0, 0);
    this.log("pointer-button", button, isDown);
  }

  async injectWheel(deltaX, deltaY) {
    this.ensureInputAvailable();
    const steps = [];
    const vertical = Math.round(Math.abs(deltaY) / 120) || (deltaY ? 1 : 0);
    const horizontal = Math.round(Math.abs(deltaX) / 120) || (deltaX ? 1 : 0);

    const pushClicks = (button, count) => {
      for (let index = 0; index < count; index += 1) {
        steps.push(button);
      }
    };

    if (deltaY < 0) pushClicks(4, vertical);
    if (deltaY > 0) pushClicks(5, vertical);
    if (deltaX < 0) pushClicks(6, horizontal);
    if (deltaX > 0) pushClicks(7, horizontal);

    for (const button of steps) {
      this.xtest.FakeInput(this.xtest.ButtonPress, button, 0, this.root, 0, 0);
      this.xtest.FakeInput(this.xtest.ButtonRelease, button, 0, this.root, 0, 0);
    }
    this.log("wheel", deltaX, deltaY, steps);
  }

  async injectKey(keySpec, isDown) {
    this.ensureInputAvailable();
    const keycode = this.resolveKeycode(keySpec);
    if (!keycode) {
      throw new Error("input-injection-unavailable");
    }

    this.xtest.FakeInput(isDown ? this.xtest.KeyPress : this.xtest.KeyRelease, keycode, 0, this.root, 0, 0);
    this.log("key", keySpec?.code, keySpec?.key, isDown, keycode);
  }

  async readClipboard() {
    if (!this.connected || !this.X || !this.selectionWindow) {
      throw new Error("clipboard-unavailable");
    }

    if (this.pendingClipboardRequest) {
      throw new Error("clipboard-request-in-progress");
    }

    const selectionAtom = await this.getAtom("CLIPBOARD");
    const owner = await getSelectionOwner(this.X, selectionAtom);
    if (!owner) {
      return "";
    }

    const targets = [
      await this.getAtom("UTF8_STRING").catch(() => null),
      this.X.atoms.STRING,
    ].filter(Boolean);

    let lastError = null;
    for (const targetAtom of targets) {
      try {
        return await this.requestClipboardTarget(selectionAtom, targetAtom);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("clipboard-unavailable");
  }

  async probeShm() {
    try {
      const info = await queryExtension(this.X, "MIT-SHM");
      return Boolean(info?.present);
    } catch {
      return false;
    }
  }

  async loadKeyboardMap() {
    const mapping = await getKeyboardMapping(this.X, this.display.min_keycode, this.display.max_keycode);
    const keycodeByKeysym = new Map();

    mapping.forEach((symbols, index) => {
      const keycode = this.display.min_keycode + index;
      for (const symbol of symbols) {
        if (symbol) {
          keycodeByKeysym.set(symbol, keycode);
        }
      }
    });

    this.keyboardMap = keycodeByKeysym;
  }

  async getAtom(name) {
    if (this.atomCache.has(name)) {
      return this.atomCache.get(name);
    }

    const atom = await internAtom(this.X, name);
    this.atomCache.set(name, atom);
    return atom;
  }

  async getWindowProperty(windowId, propertyName, type = 0) {
    if (!this.X) {
      throw new Error("x11-disconnected");
    }

    const propertyAtom = typeof propertyName === "number"
      ? propertyName
      : await this.getAtom(propertyName);
    return getProperty(this.X, windowId, propertyAtom, type);
  }

  async getWindowTextProperty(windowId, propertyName, typeName) {
    const type = typeName ? await this.getAtom(typeName).catch(() => 0) : 0;
    const property = await this.getWindowProperty(windowId, propertyName, type).catch(() => null);
    return property ? decodePropertyText(property) : "";
  }

  async getWindowStateAtoms(windowId) {
    const property = await this.getWindowProperty(windowId, "_NET_WM_STATE", this.X?.atoms?.ATOM || 0).catch(() => null);
    if (!property) {
      return [];
    }

    const atomIds = bufferToUInt32Array(property.data);
    const names = await Promise.all(atomIds.map(async (atomId) => {
      for (const [name, id] of this.atomCache.entries()) {
        if (id === atomId) {
          return name;
        }
      }

      return String(atomId);
    }));

    return names.filter(Boolean);
  }

  async listWindows() {
    if (!this.connected || !this.X || !this.root) {
      throw new Error("x11-disconnected");
    }

    const [clientListProperty, activeWindowProperty] = await Promise.all([
      this.getWindowProperty(this.root, "_NET_CLIENT_LIST", this.X.atoms.WINDOW).catch(() => null),
      this.getWindowProperty(this.root, "_NET_ACTIVE_WINDOW", this.X.atoms.WINDOW).catch(() => null),
    ]);

    const windowIds = bufferToUInt32Array(clientListProperty?.data);
    const activeWindowId = bufferToUInt32Array(activeWindowProperty?.data)[0] || 0;

    const windows = await Promise.all(windowIds.map(async (windowId) => {
      const [geometry, translated, title, wmClassProperty, pidProperty, stateAtoms] = await Promise.all([
        getGeometry(this.X, windowId).catch(() => null),
        this.X.TranslateCoordinates
          ? new Promise((resolve) => {
            this.X.TranslateCoordinates(windowId, this.root, 0, 0, (error, result) => {
              resolve(error ? null : result);
            });
          })
          : null,
        this.getWindowTextProperty(windowId, "_NET_WM_NAME", "UTF8_STRING")
          .then((value) => value || this.getWindowTextProperty(windowId, this.X.atoms.WM_NAME, this.X.atoms.STRING ? "STRING" : ""))
          .catch(async () => this.getWindowTextProperty(windowId, this.X.atoms.WM_NAME, "")),
        this.getWindowProperty(windowId, this.X.atoms.WM_CLASS, this.X.atoms.STRING).catch(() => null),
        this.getWindowProperty(windowId, "_NET_WM_PID", this.X.atoms.CARDINAL).catch(() => null),
        this.getWindowStateAtoms(windowId).catch(() => []),
      ]);

      const wmClass = decodeWmClass(wmClassProperty);
      const pid = bufferToUInt32Array(pidProperty?.data)[0] || null;

      return {
        id: `0x${windowId.toString(16)}`,
        desktop: 0,
        pid,
        x: translated?.destX ?? geometry?.xPos ?? 0,
        y: translated?.destY ?? geometry?.yPos ?? 0,
        width: geometry?.width ?? 0,
        height: geometry?.height ?? 0,
        wmClass: [wmClass.instanceName, wmClass.className].filter(Boolean).join("."),
        instanceName: wmClass.instanceName,
        className: wmClass.className,
        host: "",
        title: title || "",
        active: windowId === activeWindowId,
        stateAtoms,
        maximized: stateAtoms.includes("_NET_WM_STATE_MAXIMIZED_VERT")
          && stateAtoms.includes("_NET_WM_STATE_MAXIMIZED_HORZ"),
      };
    }));

    return windows;
  }

  async sendClientMessage(windowId, messageTypeName, data = []) {
    if (!this.X || !this.root) {
      throw new Error("x11-disconnected");
    }

    const messageType = await this.getAtom(messageTypeName);
    const eventData = Buffer.alloc(32);
    eventData.writeUInt8(33, 0);
    eventData.writeUInt8(32, 1);
    eventData.writeUInt32LE(windowId, 4);
    eventData.writeUInt32LE(messageType, 8);

    for (let index = 0; index < 5; index += 1) {
      eventData.writeUInt32LE(Number(data[index] || 0) >>> 0, 12 + (index * 4));
    }

    this.X.SendEvent(this.root, false, 0x00003000, eventData);
  }

  async focusWindow(windowId, options = {}) {
    if (!this.connected || !this.X || !this.root) {
      throw new Error("x11-disconnected");
    }

    const normalizedWindowId = typeof windowId === "string"
      ? Number.parseInt(windowId.replace(/^0x/i, ""), 16)
      : Number(windowId);
    if (!Number.isInteger(normalizedWindowId) || normalizedWindowId <= 0) {
      throw new Error("windowId is required");
    }

    if (options.maximize) {
      const maximizedVert = await this.getAtom("_NET_WM_STATE_MAXIMIZED_VERT");
      const maximizedHorz = await this.getAtom("_NET_WM_STATE_MAXIMIZED_HORZ");
      await this.sendClientMessage(normalizedWindowId, "_NET_WM_STATE", [
        1,
        maximizedVert,
        maximizedHorz,
        1,
        0,
      ]);
    }

    this.X.ConfigureWindow(normalizedWindowId, { stackMode: 0 });
    this.X.SetInputFocus(normalizedWindowId, 1);
    await this.sendClientMessage(normalizedWindowId, "_NET_ACTIVE_WINDOW", [1, 0, 0, 0, 0]);
  }

  async requestClipboardTarget(selectionAtom, targetAtom) {
    const propertyAtom = await this.getAtom(`MYAGENT_CLIPBOARD_${targetAtom}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingClipboardRequest || this.pendingClipboardRequest.propertyAtom !== propertyAtom) {
          return;
        }

        this.pendingClipboardRequest = null;
        reject(new Error("clipboard-timeout"));
      }, 2000);

      this.pendingClipboardRequest = {
        resolve,
        reject,
        timer,
        propertyAtom,
        selectionAtom,
        targetAtom,
      };

      try {
        this.X.DeleteProperty(this.selectionWindow, propertyAtom);
        this.X.ConvertSelection(this.selectionWindow, selectionAtom, targetAtom, propertyAtom, 0);
      } catch (error) {
        clearTimeout(timer);
        this.pendingClipboardRequest = null;
        reject(error);
      }
    });
  }

  async handleXEvent(event) {
    if (event?.name !== "SelectionNotify" || !this.pendingClipboardRequest || !this.X) {
      return;
    }

    const request = this.pendingClipboardRequest;
    if (event.requestor !== this.selectionWindow || event.selection !== request.selectionAtom) {
      return;
    }

    this.pendingClipboardRequest = null;
    clearTimeout(request.timer);

    if (!event.property) {
      request.reject(new Error("clipboard-target-unavailable"));
      return;
    }

    try {
      const property = await getProperty(this.X, this.selectionWindow, event.property, 0, 1);
      const text = Buffer.from(property?.data || []).toString("utf8");
      request.resolve(text);
    } catch (error) {
      request.reject(error);
    }
  }

  resolveKeycode(keySpec) {
    const keysym = this.resolveKeysym(keySpec);
    return this.keyboardMap.get(keysym) || null;
  }

  resolveKeysym(keySpec) {
    if (keySpec?.code && DOM_CODE_TO_KEYSYM[keySpec.code]) {
      return DOM_CODE_TO_KEYSYM[keySpec.code];
    }

    if (typeof keySpec?.key === "string" && keySpec.key.length === 1) {
      return keySpec.key.codePointAt(0);
    }

    if (keySpec?.key === "Enter") return keysyms.XK_Return.code;
    if (keySpec?.key === "Tab") return keysyms.XK_Tab.code;
    if (keySpec?.key === "Backspace") return keysyms.XK_BackSpace.code;
    if (keySpec?.key === "Escape") return keysyms.XK_Escape.code;
    if (keySpec?.key === "Delete") return keysyms.XK_Delete.code;
    if (keySpec?.key === " ") return 32;

    return 0;
  }

  ensureInputAvailable() {
    if (!this.xtest) {
      throw new Error("input-injection-unavailable");
    }
  }
}
