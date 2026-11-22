# Sokoban Solver

A push-optimal Sokoban solver for the make.fun competition. This solver decomposes levels into independent rooms connected by a central hallway, solves each room with a push-optimal BFS over push states, and concatenates the solutions.

## How to Run

```bash
mkdir -p out
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The program reads XSB Sokoban levels from `<input_dir>/<id>/level.txt` and writes solutions to `<output_dir>/<id>/solution.txt`.

## Algorithm

1. Parse the level and identify the hallway row (where the player starts)
2. Find door cells connecting rooms to the hallway
3. Flood-fill from each door to identify room cells
4. For each room, solve independently using BFS over push states:
   - State = sorted box positions + canonical player region ID
   - Prune corner deadlocks and freeze deadlocks
   - Reconstruct walking moves between pushes with BFS
5. Concatenate room solutions, walking along the hallway between rooms

## License

MIT License - Copyright (c) 2026 aldapratama17
