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
    this.shmAvailable = false;
    this.connected = false;
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
    this.log("connected", displayName, { shmAvailable: this.shmAvailable, xtestAvailable: Boolean(this.xtest) });

    this.connected = true;
    client.on("error", () => {});
  }

  async disconnect() {
    this.X?.terminate();
    this.log("disconnected");
    this.connected = false;
    this.display = null;
    this.X = null;
    this.screen = null;
    this.root = null;
    this.xtest = null;
    this.keyboardMap.clear();
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
