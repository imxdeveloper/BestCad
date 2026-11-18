# BestCad

BestCad is a browser based CAD prototype built with React, TypeScript, and Three.js. It provides a local 3D design workspace with sketch creation, basic solid features, assembly previews, drawings, and export tools. It is an evolving project and does not yet replace a production CAD system.

## Run locally

```sh
npm install
npm run dev
```

Create sketches on standard planes or flat model faces. Draw lines, rectangles, circles, or arcs, finish the sketch, then extrude one or more closed profiles. Reopen a sketch to edit it; new extrusions update from their linked source profile. Use the Solid ribbon for hole, shell, pattern, and Boolean operations.

Documents are saved in browser local storage. Existing CloneCad documents keep using their original storage key so local models remain available after the rename.

## Current scope

- **Design:** three.js viewport, standard and face based sketch planes, sketch editing, profile extrusion, basic patterns, approximate fillet/chamfer, shell/hole, and Boolean operations.
- **Assembly:** joint sliders, exploded view, and BOM export prototype.
- **Drawings and exports:** SVG drawings, STL, OBJ, glTF, STEP, and BOM CSV export.
- **Manufacture and simulation:** CAM toolpath preview and approximate static stress visualization.
- **Automation:** script templates and a local script runner.

These workspaces have prototype status. Important CAD capabilities still in development include a real constraint solver integrated with sketch editing, revolve/loft/sweep, a robust feature history and dependency graph, advanced B-rep operations, production-grade assemblies and drawings, and cloud collaboration.

## Build

```sh
npm run build
```
