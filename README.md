# CloneCad - Professional 3D Cloud CAD Workspace

CloneCad is a modern, high-performance browser-based 3D CAD workspace built with React, TypeScript, and Three.js. It integrates core professional CAD paradigms inspired by SOLIDWORKS, Autodesk Fusion 360, and PTC Onshape: parametric multi-plane sketching, solid modeling, kinematic assembly mating, 2D engineering drawings, finite element analysis (FEA), 2.5D CAM toolpath generation, physical property inspection, and FeatureScript automation.

## Run locally

```sh
npm install
npm run dev
```

To verify code quality and build:
```sh
npm run lint
npm run build
```

---

## Capabilities & Workspace Matrix

| Workspace | Features & Capabilities | Status |
| :--- | :--- | :--- |
| **Design** | Parametric sketches, Extrude (with depth dragging handle), Revolve (360°/angular), Fillet/Chamfer, Shell, Hole, Linear Pattern, **Circular Pattern**, Mirror, CSG Combine (Join/Cut/Intersect), Section Analysis clipping plane, and Physical Measure tool. | **Fully Functional** |
| **Assemble** | Kinematic Mates/Joints (Revolute, Slider, Rigid, Cylindrical) with interactive degree-of-freedom sliders; **0%–100% Exploded View slider**; Live Bill of Materials (BOM) Table with volume (cm³), mass (g), dimensions, and CSV export. | **Fully Functional** |
| **Drawings** | Orthographic 3rd Angle Multi-View Sheet generator (Front, Top, Right, Isometric projection); ISO/ANSI Title Block with live document metadata; automatic dimension callouts; Print and SVG export. | **Fully Functional** |
| **Manufacture** | 2.5D CNC Machining Setup with stock bounding box; toolpath calculation for Facing (Zigzag), Adaptive Pocketing, and Contour Profiling; 3D G-code toolpath trajectories; G-code RS-274 / Fanuc exporter. | **Fully Functional** |
| **Simulation** | Linear Static Stress Finite Element Analysis (FEA); Von Mises Stress 3D color gradient mapping (Turbo/Jet heatmap); automated Factor of Safety (FOS) and Yield Strength calculations. | **Fully Functional** |
| **Visualize** | PBR Engineering Material Library (316L Stainless Steel, 6061 Aluminum, Grade 5 Titanium, C36000 Brass, Pure Copper, 24K Gold, Carbon Fiber, Clear Acrylic, POM Delrin, ABS Plastic); Studio lighting; High-res PNG snapshot capture. | **Fully Functional** |
| **Manage** | Version Control & History snapshots; Multi-format export suite: **ISO 10303-21 STEP (.stp)**, Binary STL, Wavefront OBJ, glTF 2.0, Drawing SVG, and BOM CSV. | **Fully Functional** |
| **Automate** | Built-in FeatureScript & Automation IDE with runnable engineering templates (Parametric Spur Gear, Bolt Flange with Hole Pattern, Heatsink with Cooling Fins), interactive script editor, and execution console. | **Fully Functional** |
| **Electronics** | Enclosure workbench, board standoff positioning, and keepout regions. | **Functional** |

---

## Core Engineering Features

### 1. Multi-Format Industrial Export Suite
- **ISO 10303-21 STEP (`.stp`)**: Industry-standard AP203/AP214 format for cross-platform exchange with SolidWorks, Fusion 360, Onshape, and FreeCAD.
- **Binary STL (`.stl`)**: High-performance binary STL for 3D printing and additive manufacturing.
- **Wavefront OBJ (`.obj`) & glTF 2.0 (`.gltf`)**: Full 3D mesh exchange formats.
- **Engineering SVG (`.svg`)**: Scalable vector drawing sheet with ANSI title block.
- **Bill of Materials CSV (`.csv`)**: Comprehensive component list, material types, and weights for ERP/purchasing.

### 2. Assembly & Kinematic Joints
- Supports **Revolute** (rotational DOF), **Slider** (linear stroke DOF), and **Rigid** mates.
- **Interactive Exploded View**: Smoothly separates components outward from the assembly centroid for inspection and documentation.
- **Live BOM**: Automatically computes total volume and mass using physical material density.

### 3. Inspection & Physical Property Evaluation
- Exact volume, surface area, and center of mass computed using divergence theorem integration on closed meshes.
- Quick measurement tool for distances between components.
- Real-time **Section Analysis** tool allowing slicing across any principal plane (X, Y, Z) with interactive depth offset and inversion.

### 4. Camera Projection
- Real-time toggling between **Perspective Camera** (natural human viewing) and **Orthographic Camera** (true parallel projection required for engineering inspection).
