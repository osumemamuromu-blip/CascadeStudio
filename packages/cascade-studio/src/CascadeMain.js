// CascadeMain.js - ES Module
// This script governs the layout and initialization of all of the sub-windows

import { createDockview } from '../lib/dockview-core/dockview-core.js';
import { CascadeEnvironment } from './CascadeView.js';
import { CascadeEngine, OpenSCADTranspiler } from 'cascade-core';
import { EditorManager } from './EditorManager.js';
import { ConsoleManager } from './ConsoleManager.js';
import { GUIManager } from './GUIManager.js';
import { OpenSCADMonaco } from './openscad/OpenSCADMonaco.js';
import { CascadeAPI } from './CascadeAPI.js';
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

/** Adapter that wraps a dockview panel to provide a Golden-Layout-compatible container API.
 *  This minimizes changes needed in EditorManager, ConsoleManager, and CascadeView. */
class DockviewContainer {
  constructor(element, panelApi) {
    this.element = element;
    this._panelApi = panelApi;
    this._state = {};
    this._resizeCallbacks = [];

    panelApi.onDidDimensionsChange(() => {
      this._resizeCallbacks.forEach(cb => cb());
    });
  }

  get width()  { return this.element.offsetWidth; }
  get height() { return this.element.offsetHeight; }

  setState(obj) { this._state = obj; }
  getState()    { return this._state; }
  setTitle(title) { this._panelApi.setTitle(title); }

  on(event, callback) {
    if (event === 'resize') {
      this._resizeCallbacks.push(callback);
    }
  }

  // Stub for CascadeView's layoutManager access
  get layoutManager() {
    return {
      eventHub: { emit: () => {} },
      updateSize: () => {}
    };
  }
}

/** Main application class for Cascade Studio.
 *  Manages layout, editor, worker, and UI state. */
class CascadeStudioApp {
  constructor() {
    this.myLayout = null;
    this._dockviewApi = null;
    this.engine = null;
    this.editor = null;
    this.console = null;
    this.gui = null;
    this.viewport = null;
    this.api = null;
    this.startup = null;
    this.file = {};

    // OpenSCAD support
    this._openscadTranspiler = new OpenSCADTranspiler();
    this._openscadMonaco = new OpenSCADMonaco();

    window.workerWorking = false;
  }

  // Backward compatibility: messageBus accessor via engine
  get messageBus() { return this.engine ? this.engine.messageBus : null; }

  /** Start the application: create the engine, wire up events, and initialize. */
  start() {
    // Create the CascadeEngine (wraps Worker + MessageBus)
    const workerPath = typeof ESBUILD !== 'undefined' ? './cascade-worker.js' : './js/CADWorker/CascadeStudioMainWorker.js';
    this.engine = new CascadeEngine({ workerUrl: workerPath });

    // Create subsystem managers
    this.editor = new EditorManager(this);
    this.console = new ConsoleManager(this);
    this.gui = new GUIManager(this);

    // Backward compatibility: expose functions to window for inline HTML event handlers
    window.cascadeApp = this;
    window.saveProject = () => this.saveProject();
    window.loadProject = () => this.loadProject();
    window.loadFiles = (id) => this.loadFiles(id);
    window.clearExternalFiles = () => this.clearExternalFiles();

    // Install the programmatic API
    this.api = new CascadeAPI(this);
    this.api.install();

    // Register OpenSCAD language with Monaco (for syntax highlighting)
    this._openscadMonaco.registerLanguage();

    // Mode toggle handler — save/restore code per mode
    this._savedCode = {};
    const modeSelect = document.getElementById('editorMode');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        const newMode = e.target.value;
        // Save current code for the current mode
        this._savedCode[this.editor.mode] = this.editor.getCode();
        this.editor.setMode(newMode);
        // Load saved code or starter code for the new mode
        const starter = newMode === 'openscad'
          ? CascadeStudioApp.OPENSCAD_STARTER_CODE
          : CascadeStudioApp.STARTER_CODE;
        this.editor.setCode(this._savedCode[newMode] || starter);
        // Re-fit camera and auto-evaluate
        if (this.viewport) { this.viewport._fitOnNextRender = true; }
        this.editor.evaluateCode();
      });
    }

    // Initialize the engine (loads worker + WASM), then start the layout
    this.engine.init().then(() => {
      // The engine is ready — register event handlers and initialize the UI

      // Wire up engine events for GUI controls
      this.gui.registerHandlers(this.engine);

      // Wire up engine events for console (log, error, progress)
      this.engine.on('log', (payload) => { console.log(payload); });
      this.engine.on('error', (payload) => {
        window.workerWorking = false;
        console.error(payload);
      });
      this.engine.on('Progress', (payload) => {
        let el = this.console._consoleContainer?.parentElement?.lastElementChild?.lastElementChild;
        if (el) {
          el.innerText = "> Generating Model" + ".".repeat(payload.opNumber) + ((payload.opType) ? " (" + payload.opType + ")" : "");
        }
      });
      this.engine.on('resetWorking', () => { window.workerWorking = false; });

      // Wire up engine events for viewport
      this.engine.on('modelHistory', (steps) => {
        if (this.viewport) {
          this.viewport.setHistorySteps(steps);
        }
      });

      // Wire up file loading callback
      this.engine.on('loadFiles', (extFiles) => {
        console.log("Storing loaded files!");
        this.console.goldenContainer.setState(extFiles);
      });

      // Wire up file saving callback
      this.engine.on('saveFile', (payload) => {
        let link = document.createElement("a");
        link.href = payload.fileURL;
        link.download = payload.filename;
        link.click();
      });

      // Wire up transform handle creation
      this.engine.on('createTransformHandle', (payload) => {
        if (this.viewport && this.viewport.handleManager) {
          this.viewport.handleManager.createTransformHandle(payload);
        }
      });

      // Backward compat: expose messageHandlers to window
      window.messageHandlers = this.engine.messageBus.handlers;

      // Start the application with startup callback behavior
      this.startup = () => {
        let curState = this.console.goldenContainer?.getState();
        if (curState && Object.keys(curState).length > 0) {
          this.engine.loadPrexistingExternalFiles(curState);
        }
        this.editor.evaluateCode();
      };
      this.startup();
    });

    // Initialize the layout immediately (don't wait for WASM)
    this.initialize();
  }

  /** Initialize the layout and load project content. */
  initialize(projectContent = null) {
    let searchParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
    let loadFromURL = searchParams.has("code");

    let codeStr = CascadeStudioApp.STARTER_CODE;
    this.gui.state = {};

    if (projectContent) {
      // Load from saved project — extract code and state from the serialized layout
      try {
        let parsed = JSON.parse(projectContent);
        if (parsed._cascadeState) {
          // New Dockview project format
          codeStr = parsed._cascadeState.code || codeStr;
          this.gui.state = parsed._cascadeState.guiState || {};
        } else if (parsed.content || parsed.root) {
          // Legacy GoldenLayout project format — extract code from componentState
          let code = this._extractLegacyCode(parsed);
          if (code) { codeStr = code; }
        }
      } catch (e) {
        console.error("Failed to parse project:", e);
      }
    } else if (loadFromURL) {
      codeStr = CascadeStudioApp.decode(searchParams.get("code"));
      this.gui.state = JSON.parse(CascadeStudioApp.decode(searchParams.get("gui")));
    }

    // Dispose previous layout
    if (this._dockviewApi) {
      this._dockviewApi.dispose();
      this._dockviewApi = null;
    }

    const appBody = document.getElementById("appbody");
    appBody.innerHTML = '';

    // Set layout height
    const topnavHeight = document.getElementById('topnav').offsetHeight;
    appBody.style.height = (window.innerHeight - topnavHeight) + 'px';

    this._dockviewApi = createDockview(appBody, {
      className: 'dockview-theme-dark',
      disableFloatingGroups: true,
      createComponent: (options) => {
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.overflow = 'hidden';

        return {
          element,
          init: (params) => {
            const container = new DockviewContainer(element, params.api);

            switch (options.name) {
              case 'codeEditor':
                container.setState({ code: params.params?.code || codeStr });
                this.editor.initPanel(container, container.getState());
                break;
              case 'cascadeView':
                container.setState(params.params?.guiState || this.gui.state);
                this._initCascadeView(container, container.getState());
                break;
              case 'console':
                this.console.initPanel(container);
                break;
            }
          }
        };
      }
    });

    // Add panels — use vertical stack on mobile, side-by-side on desktop
    const isMobile = window.innerHeight > window.innerWidth;

    if (isMobile) {
      // Mobile: cascadeView on top, editor below, console at bottom
      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state }
      });

      this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr },
        position: { referencePanel: 'cascadeView', direction: 'below' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'codeEditor', direction: 'below' }
      });

      // Set proportions after dockview grid initializes
      setTimeout(() => {
        try {
          const h = appBody.offsetHeight;
          viewPanel.group.api.setSize({ height: Math.floor(h * 0.25) });
          consolePanel.group.api.setSize({ height: Math.floor(h * 0.05) });
        } catch (e) { /* ignore */ }
      }, 50);
    } else {
      // Desktop: editor left, cascadeView right, console below view
      const editorPanel = this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr }
      });

      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state },
        position: { referencePanel: 'codeEditor', direction: 'right' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'cascadeView', direction: 'below' }
      });

      // Set initial proportions (editor ~50%, view+console ~50%, console 15% height)
      setTimeout(() => {
        try {
          const editorGroup = editorPanel.group;
          const viewGroup = viewPanel.group;
          if (editorGroup && viewGroup) {
            editorGroup.api.setSize({ width: Math.floor(appBody.offsetWidth * 0.5) });
          }
          consolePanel.group.api.setSize({ height: Math.floor(appBody.offsetHeight * 0.15) });
        } catch (e) { /* setSize may not be available on initial render */ }
      }, 50);
    }

    // Resize the layout when the browser resizes
    if (this._updateLayoutSize) {
      window.removeEventListener('resize', this._updateLayoutSize);
      window.removeEventListener('orientationchange', this._updateLayoutSize);
    }
    this._updateLayoutSize = () => {
      const h = window.innerHeight - document.getElementById('topnav').offsetHeight;
      appBody.style.height = h + 'px';
    };
    window.addEventListener('resize', this._updateLayoutSize);
    window.addEventListener('orientationchange', this._updateLayoutSize);
    requestAnimationFrame(this._updateLayoutSize);
  }

  /** Initialize the Three.js 3D Viewport. */
  _initCascadeView(container, state) {
    this.gui.state = state;
    container.setState(this.gui.state);

    if (this.viewport) {
      this.viewport.active = false;
      this.viewport = null;
    }

    let floatingGUIContainer = document.createElement("div");
    floatingGUIContainer.className = 'gui-panel';
    floatingGUIContainer.id = "guiPanel";
    container.element.appendChild(floatingGUIContainer);

    this.viewport = new CascadeEnvironment(
      container, this,
      CascadeStudioApp.getNewFileHandle, CascadeStudioApp.writeFile, CascadeStudioApp.downloadFile
    );
    window.threejsViewport = this.viewport;

    // Wire timeline step changes to editor line highlighting
    this._historyDecorations = [];
    this.viewport._onHistoryStepChange = (lineNumber) => {
      let editor = window.monacoEditor;
      if (!editor) return;
      if (lineNumber && lineNumber > 0) {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, [{
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            isWholeLine: true,
            className: 'cs-history-line-highlight',
            glyphMarginClassName: 'cs-history-glyph'
          }
        }]);
        editor.revealLineInCenter(lineNumber);
      } else {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, []);
      }
    };
  }

  /** Serialize the project's current state into a .json file and save it. */
  async saveProject() {
    let currentCode = this.editor.getCode();
    if (!this.file.handle) {
      this.file.handle = await CascadeStudioApp.getNewFileHandle(
        "Cascade Studio project files", "application/json", "json"
      );
    }

    // Save as a custom format with layout + cascade state
    let projectData = {
      _cascadeState: {
        code: currentCode,
        guiState: this.gui.state,
        externalFiles: this.console.goldenContainer.getState()
      }
    };
    if (this._dockviewApi) {
      projectData._dockviewLayout = this._dockviewApi.toJSON();
    }

    CascadeStudioApp.writeFile(this.file.handle, JSON.stringify(projectData, null, 2)).then(() => {
      this.editor.container.setTitle(this.file.handle.name);
      console.log("Saved project to " + this.file.handle.name);
      this.file.content = currentCode;
    });
  }

  /** Load a .json file as the current project. */
  async loadProject() {
    if (window.workerWorking) { return; }

    [this.file.handle] = await CascadeStudioApp.getNewFileHandle(
      'Cascade Studio project files', 'application/json', 'json', true
    );
    let fileSystemFile = await this.file.handle.getFile();
    let jsonContent = await fileSystemFile.text();
    window.history.replaceState({}, 'Cascade Studio', '?');
    this.initialize(jsonContent);
    this.editor.container.setTitle(this.file.handle.name);
    this.file.content = this.editor.getCode();
  }

  /** Trigger the CAD WebWorker to load one or more .stl, .step, or .iges files. */
  loadFiles(fileElementID = "files") {
    let files = document.getElementById(fileElementID).files;
    this.engine.importFiles(files);
  }

  /** Clear all externally loaded files from the `externalFiles` dict. */
  clearExternalFiles() {
    this.engine.clearExternalFiles();
    this.console.goldenContainer.setState({});
  }

  /** Extract code from a legacy GoldenLayout project file. */
  _extractLegacyCode(parsed) {
    // Recursively search for componentState.code in GoldenLayout config
    function findCode(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.componentState && obj.componentState.code) return obj.componentState.code;
      for (let key of ['content', 'root', 'children']) {
        if (Array.isArray(obj[key])) {
          for (let child of obj[key]) {
            let result = findCode(child);
            if (result) return result;
          }
        }
      }
      return null;
    }
    return findCode(parsed);
  }

  // --- Static utility methods ---

  /** Get a new file handle via the File System Access API. */
  static async getNewFileHandle(desc, mime, ext, open = false) {
    const options = {
      types: [{
        description: desc,
        accept: { [mime]: ['.' + ext] },
      }],
    };
    if (open) {
      return await window.showOpenFilePicker(options);
    } else {
      return await window.showSaveFilePicker(options);
    }
  }

  /** Write contents to a file handle. */
  static async writeFile(fileHandle, contents) {
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  /** Download data as a file via a temporary anchor element. */
  static async downloadFile(data, name, mime, ext) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.download = name + "." + ext;
    a.style.display = "none";
    a.href = window.URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(a.href);
  }

  /** Decode a base64+compressed string to the original. Uses fflate. */
  static decode(string) {
    const compressed = Uint8Array.from(atob(decodeURIComponent(string)), c => c.charCodeAt(0));
    return strFromU8(inflateSync(compressed));
  }

  /** Encode a string to a base64+compressed version. Uses fflate. */
  static encode(string) {
    const compressed = deflateSync(strToU8(string));
    // Build binary string in chunks to avoid stack overflow with large data
    let binaryStr = '';
    const chunkSize = 8192;
    for (let i = 0; i < compressed.length; i += chunkSize) {
      binaryStr += String.fromCharCode.apply(null, compressed.subarray(i, i + chunkSize));
    }
    return encodeURIComponent(btoa(binaryStr));
  }

  /** Returns true if item is indexable like an array. */
  static isArrayLike(item) {
    return (
      Array.isArray(item) ||
      (!!item &&
        typeof item === "object" &&
        item.hasOwnProperty("length") &&
        typeof item.length === "number" &&
        item.length > 0 &&
        (item.length - 1) in item
      )
    );
  }
}

/** Default starter code shown in the editor. */
CascadeStudioApp.STARTER_CODE =
`// Welcome to Cascade Studio!  A Browser-Based CAD Modeling Environment.
// Adjust these sliders to modify the model in real time:
let width     = Slider("Width",      80, 40, 120);
let depth     = Slider("Depth",      60, 30, 100);
let height    = Slider("Height",     30, 15, 50);
let wall      = Slider("Wall",        3,  2,  8);
let filletR   = Slider("Fillet",       6,  1, 15);
let showLabel = Checkbox("Label",   true);

// --- Base Tray (Sketch + Extrude) ---
// Sketch: Draw a rounded-rectangle, then extrude it into a solid
let outerFace = new Sketch([-width/2, -depth/2])
  .LineTo([ width/2, -depth/2]).Fillet(filletR)
  .LineTo([ width/2,  depth/2]).Fillet(filletR)
  .LineTo([-width/2,  depth/2]).Fillet(filletR)
  .LineTo([-width/2, -depth/2]).Fillet(filletR)
  .End(true).Face();
let tray = Extrude(outerFace, [0, 0, height], true);  // keepFace: reuse for Offset below

// Offset: Create inner profile while outerFace is still intact
let innerFace = Offset(outerFace, -wall);

// FilletEdges + Selector: Round the top rim edges
let topEdges = Edges(tray).max([0,0,1]).indices();
tray = FilletEdges(tray, wall * 0.4, topEdges);

// Difference: Hollow out to create a tray
let cavity = Translate([0, 0, wall], Extrude(innerFace, [0, 0, height]));
tray = Difference(tray, [cavity]);

// --- Divider (Box + Union) ---
let divider = Translate([-wall/2, -(depth - wall*2)/2, wall],
  Box(wall, depth - wall*2, height - wall*2));
tray = Union([tray, divider]);

// --- Pen Holder (Revolve + ChamferEdges) ---
// Revolve an L-shaped profile around Z to create a hollow cup in one step
let penR = depth / 4;
let penH = height * 1.6;
let penX = width/2 + penR + 3;
let cupProfile = Polygon([
  [0, 0, 0], [penR, 0, 0], [penR, 0, penH],
  [penR - wall, 0, penH], [penR - wall, 0, wall], [0, 0, wall]
]);
let holder = Revolve(cupProfile, 360, [0, 0, 1]);
let chamferEdges = Edges(holder).max([0,0,1]).ofType("Circle").indices();
holder = ChamferEdges(holder, wall * 0.3, chamferEdges);
Translate([penX, 0, 0], holder);

// --- Decorative Cutout (Sphere + Boolean + Mirror) ---
let cutR = Math.min(8, height * 0.25);
let cutout = Translate([0, -depth/2, height * 0.5], Sphere(cutR));
tray = Difference(tray, [cutout]);
// Mirror: Matching cutout on the back wall
tray = Difference(tray, [Mirror([0, 1, 0], cutout)]);

// --- RotatedExtrude: Decorative twisted accent ---
let spiralWire = Translate([3, 0, 0], Circle(1.5, true));
let spiral = RotatedExtrude(spiralWire, 12, 180);
Translate([-width/2 - 6, -depth/4, 0], spiral);

// --- 3D Text Label ---
if (showLabel) {
  let label = Text3D("CS", 10, wall * 0.2, "Consolas");
  Translate([width/4, -depth/2 - wall * 0.2, height * 0.3], label);
}

// --- Measurements ---
console.log("Volume:  " + Math.abs(Volume(tray)).toFixed(0) + " mm\\u00B3");
console.log("Surface: " + SurfaceArea(tray).toFixed(0) + " mm\\u00B2");
let com = CenterOfMass(tray);
console.log("Center:  [" + com.map(v => v.toFixed(1)).join(", ") + "]");`;

/** Default OpenSCAD starter code shown when switching to OpenSCAD mode. */
CascadeStudioApp.OPENSCAD_STARTER_CODE =
`// Parametric Bolt and Nut
// Demonstrates modules, intersection, difference, and transforms

hex_r = 10;
hex_h = 6;
bore_r = 5;
shaft_r = 4.8;
shaft_h = 25;

// Hex prism: three intersecting boxes
module hex(r, h) {
  intersection() {
    cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, 60])
      cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, -60])
      cube([r * 2, r * 1.73, h], center = true);
  }
}

// Bolt head
hex(hex_r, hex_h);

// Shaft
translate([0, 0, hex_h / 2])
  cylinder(h = shaft_h, r = shaft_r);

// Washer
translate([0, 0, shaft_h])
  difference() {
    cylinder(h = 2, r = hex_r - 1);
    cylinder(h = 3, r = bore_r);
  }

// Nut with bore hole
translate([0, 0, shaft_h + 2])
  difference() {
    hex(hex_r, hex_h);
    cylinder(h = hex_h + 1, r = bore_r, center = true);
  }
`;


/** Simple prompt-to-CAD workspace */
function installPromptCAD() {
  if (document.getElementById("promptCADPanel")) return;

  const panel = document.createElement("div");
  panel.id = "promptCADPanel";

  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "9999",
    top: "70px",
    left: "10px",
    right: "10px",
    maxWidth: "560px",
    margin: "0 auto",
    padding: "14px",
    background: "#17191f",
    color: "#ffffff",
    border: "1px solid #454955",
    borderRadius: "12px",
    boxShadow: "0 6px 24px #0008",
    fontFamily: "Arial, sans-serif"
  });

  panel.innerHTML = `
    <div style="font-size:17px;font-weight:700;margin-bottom:8px">
      Malie AI · 3D Builder
    </div>
    <div style="font-size:13px;color:#c3c7d1;margin-bottom:10px">
      Describe a basic 3D object and its dimensions.
    </div>
    <input id="promptCADInput"
      placeholder="e.g. cylinder 40 mm diameter, 100 mm tall"
      style="box-sizing:border-box;width:100%;padding:12px;
      border-radius:8px;border:1px solid #555;background:#242832;
      color:white;font-size:14px;margin-bottom:9px">
    <button id="promptCADGenerate"
      style="padding:11px 15px;border:0;border-radius:8px;
      background:#4779f5;color:white;font-weight:700">
      Generate 3D Model
    </button>
    <button id="promptCADHide"
      style="padding:11px 12px;margin-left:6px;border:1px solid #555;
      border-radius:8px;background:#242832;color:white">
      Hide
    </button>
    <div id="promptCADStatus"
      role="status"
      style="font-size:13px;margin-top:10px;color:#c3c7d1">
      Ready
    </div>
  `;

  document.body.appendChild(panel);
  
  const restoreCADButton = document.createElement("button");
  restoreCADButton.textContent = "＋ Open 3D Builder";
  Object.assign(restoreCADButton.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "10000",
    padding: "12px 16px",
    border: "0",
    borderRadius: "10px",
    background: "#4779f5",
    color: "white",
    fontWeight: "700",
    cursor: "pointer",
    display: "none"
  });
  document.body.appendChild(restoreCADButton);

  restoreCADButton.onclick = () => {
    panel.style.display = "block";
    restoreCADButton.style.display = "none";
  };


  const input = panel.querySelector("#promptCADInput");
  const generate = panel.querySelector("#promptCADGenerate");
  const status = panel.querySelector("#promptCADStatus");
  let requestTimeout = null;

  panel.querySelector("#promptCADHide").onclick = () => {
  panel.style.display = "none";
  restoreCADButton.style.display = "block";
};

  function buildCode(description) {
    const text = description.toLowerCase();

    const numbers = text.match(/\d+(?:\.\d+)?/g);
    const values = numbers ? numbers.map(Number) : [];

    if (!values.length) {
      throw new Error("Include dimensions, for example: box 40 30 20 mm.");
    }

    if (/\b(sphere|ball)\b/.test(text)) {
      const radius = values[0];
      return `Sphere(${radius});`;
    }

    if (/\b(cone)\b/.test(text)) {
      const radius = values[0];
      const height = values[1] || radius * 2;
      return `Cone(${radius}, 0, ${height});`;
    }

    if (/\b(cylinder|pipe|shaft|rod)\b/.test(text)) {
      let radius, height;

      if (/\bdiameter\b/.test(text)) {
        radius = values[0] / 2;
        height = values[1];
      } else if (/\bradius\b/.test(text)) {
        radius = values[0];
        height = values[1];
      } else {
        radius = values[0];
        height = values[1];
      }

      if (!height) {
        throw new Error(
          "Provide radius and height, or diameter and height."
        );
      }

      return `Cylinder(${radius}, ${height});`;
    }

    if (/\b(box|block|cube|cuboid|rectangular)\b/.test(text)) {
      const x = values[0];
      const y = values[1] || x;
      const z = values[2] || x;

      return `Translate([-${x}/2,-${y}/2,0], Box(${x},${y},${z}));`;
    }

    throw new Error(
      "For this first version, try box, cylinder, sphere, or cone."
    );
  }

   generate.onclick = async () => {
    if (!window.CascadeAPI || !window.CascadeAPI.isReady()) {
      status.textContent = "CAD engine is still loading. Try again shortly.";
      return;
    }

    if (window.CascadeAPI.isWorking()) {
      status.textContent = "A model is already generating. Please wait.";
      return;
    }

    const prompt = input.value.trim();

    if (!prompt) {
      status.textContent = "Describe the model you want to create.";
      return;
    }

    generate.disabled = true;
    status.textContent = "Sending your request to Malie AI...";

    const requestId = crypto.randomUUID();
    window.pendingMalieCadRequestId = requestId;
     if (requestTimeout !== null) clearTimeout(requestTimeout);

requestTimeout = setTimeout(() => {
  if (window.pendingMalieCadRequestId !== requestId) return;

  window.pendingMalieCadRequestId = null;
  requestTimeout = null;
  status.textContent =
    "Malie AI did not respond within 60 seconds. Check your connection and try again.";
  generate.disabled = false;
}, 60000);

    window.parent.postMessage({
      type: "MALIE_CAD_GENERATE",
      requestId,
      prompt
    }, "https://oracle-ai.osumemamuromu.workers.dev");
  }; 

  
  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent) return;

    const message = event.data;

    if (
      !message ||
      message.type !== "MALIE_CAD_RESULT" ||
      message.requestId !== window.pendingMalieCadRequestId
    ) {
      return;
    }

    window.pendingMalieCadRequestId = null;
    if (requestTimeout !== null) {
  clearTimeout(requestTimeout);
  requestTimeout = null;
    }

    if (message.error || !message.result?.ok) {
      status.textContent =
        message.error ||
        message.result?.error ||
        "Malie AI could not generate this model.";
      generate.disabled = false;
      return;
    }

    try {
      status.textContent = "Rendering your 3D model...";

      const result = await window.CascadeAPI.runCode(
        message.result.code
      );

      if (!result.success) {
        throw new Error(
          (result.errors || [])
            .map(e =>
              typeof e === "string"
                ? e
                : e.message || JSON.stringify(e)
            )
            .join(" ")
        );
      }

      window.CascadeAPI.fitCamera();
      status.textContent = "Model generated successfully.";
    } catch (error) {
      status.textContent =
        error.message || "Could not render the model.";
    } finally {
      generate.disabled = false;
    }
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") generate.click();
  });
}

// Install after the existing app has started.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installPromptCAD);
} else {
  installPromptCAD();
}

export { CascadeStudioApp };
