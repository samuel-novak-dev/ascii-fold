// Public entry point. Importing this module also registers the <ascii-fold> element.
export { createAsciiFold, PALETTES, GLYPHS, DETAIL, DEFAULTS, COLOURS, solidColour } from "./engine.js";
export { buildGeometry, SHAPE_DEFAULT } from "./geometry.js";
export { parsePDB, parseCIF, parseStructure, readStructureFile } from "./parse.js";
export { assignSS } from "./ss.js";
export { fetchAFDB, normalizeAccession, describeAFDB, AFDBError, AFDB } from "./afdb.js";
export { AsciiFoldElement } from "./ascii-fold-element.js";
