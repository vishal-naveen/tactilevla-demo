# SO-101 model assets

The URDF (`so101_new_calib.urdf`) and STL meshes in this folder come from
[TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100)
(`Simulation/SO101/`), licensed under the Apache License 2.0.

Modifications: the STL meshes in `assets/` were **decimated** (triangle counts reduced roughly
4-8x, quadric edge-collapse via meshoptimizer) to keep page weight low. Filenames and
coordinate frames are unchanged, so the URDF works as published. The URDF itself is unmodified.
The decimated meshes are for visualisation only and are not suitable for printing.
