"""
One-time script: exports the fsaverage5 cortical mesh (both hemispheres)
as a single OBJ file for use in the Three.js frontend.

Run once:
    python export_mesh.py

Output: ../assets/fsaverage5.obj
"""

import os
import numpy as np
from nilearn import datasets, surface

OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'fsaverage5.obj')

def export_mesh():
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    print("Fetching fsaverage5 surface...")
    fsaverage = datasets.fetch_surf_fsaverage('fsaverage5')

    # Load both hemispheres
    lh_coords, lh_faces = surface.load_surf_mesh(fsaverage.pial_left)
    rh_coords, rh_faces = surface.load_surf_mesh(fsaverage.pial_right)

    n_left = len(lh_coords)

    # Offset right hemisphere face indices by number of left vertices
    rh_faces_offset = rh_faces + n_left

    all_coords = np.vstack([lh_coords, rh_coords])
    all_faces  = np.vstack([lh_faces, rh_faces_offset])

    print(f"Vertices: {len(all_coords)} ({n_left} left + {len(rh_coords)} right)")
    print(f"Faces:    {len(all_faces)}")
    print(f"Writing to {os.path.abspath(OUTPUT)} ...")

    with open(OUTPUT, 'w') as f:
        # Write hemisphere vertex count as a comment so app.js knows the split
        f.write(f"# fsaverage5 both hemispheres\n")
        f.write(f"# left_vertices={n_left}\n")
        f.write(f"# total_vertices={len(all_coords)}\n")
        for v in all_coords:
            f.write(f"v {v[0]:.4f} {v[1]:.4f} {v[2]:.4f}\n")
        for face in all_faces:
            f.write(f"f {face[0]+1} {face[1]+1} {face[2]+1}\n")

    print("Done.")

if __name__ == '__main__':
    export_mesh()
