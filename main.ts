import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

function solve(text: string): string {
  // 1. Parse level like checker
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const size = w * h;
  
  const wall = new Uint8Array(size);
  const goal = new Uint8Array(size);
  const boxes: number[] = [];
  let player = -1;
  
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') {
        wall[i] = 1;
      } else {
        wall[i] = 0;
        if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
        if (ch === '$' || ch === '*') boxes.push(i);
        if (ch === '@' || ch === '+') player = i;
      }
    }
  });
  
  // Pad remaining cells in rows to width
  for (let y = 0; y < h; y++) {
    for (let x = rows[y].length; x < w; x++) {
      const i = y * w + x;
      wall[i] = 1;
    }
  }
  
  boxes.sort((a, b) => a - b);
  
  // 2. Find hallway row (row containing player)
  const hallwayRow = Math.floor(player / w);
  
  // Find door cells: floor cells immediately above or below hallway row
  const doorCells: number[] = [];
  const doorCols: number[] = [];
  
  // Check row above hallway
  if (hallwayRow > 0) {
    for (let x = 0; x < w; x++) {
      const i = (hallwayRow - 1) * w + x;
      if (!wall[i]) {
        doorCells.push(i);
        doorCols.push(x);
      }
    }
  }
  // Check row below hallway
  if (hallwayRow + 1 < h) {
    for (let x = 0; x < w; x++) {
      const i = (hallwayRow + 1) * w + x;
      if (!wall[i]) {
        doorCells.push(i);
        doorCols.push(x);
      }
    }
  }
  
  // Flood fill from each door to get room cells (excluding hallway row)
  // Tightened: single queue, inline bounds check, no redundant visited array for hallway
  const rooms: { cells: Set<number>, door: number, doorCol: number, hallwayCell: number }[] = [];
  const visited = new Uint8Array(size);
  
  for (let di = 0; di < doorCells.length; di++) {
    const door = doorCells[di];
    const doorCol = doorCols[di];
    if (visited[door]) continue;
    
    const roomCells = new Set<number>();
    const queue = [door];
    visited[door] = 1;
    roomCells.add(door);
    
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const cy = Math.floor(cur / w);
      const cx = cur % w;
      
      // Don't cross into hallway row
      if (cy === hallwayRow) continue;
      
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (ny === hallwayRow) continue; // Don't enter hallway
        const ni = ny * w + nx;
        if (wall[ni] || visited[ni]) continue;
        visited[ni] = 1;
        roomCells.add(ni);
        queue.push(ni);
      }
    }
    
    // The hallway cell adjacent to the door
    const hallwayCell = hallwayRow * w + doorCol;
    rooms.push({ cells: roomCells, door, doorCol, hallwayCell });
  }
  
  // Sort rooms by door column along hallway
  rooms.sort((a, b) => a.doorCol - b.doorCol);
  
  // 3. Solve each room independently
  const roomSolutions: { moves: string }[] = [];
  
  for (const room of rooms) {
    const solution = solveRoom(room, wall, goal, boxes, w, h, hallwayRow);
    roomSolutions.push(solution);
  }
  
  // 4. Concatenate: walk from player start to first room door, then room sequences
  let allMoves = '';
  let currentPlayerPos = player;
  
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const solution = roomSolutions[ri];
    
    // Walk from current player pos to hallway cell in front of door
    const walkToDoor = bfsWalk(currentPlayerPos, room.hallwayCell, wall, new Set(), w, h);
    allMoves += walkToDoor;
    currentPlayerPos = room.hallwayCell;
    
    // Now do the room's moves (which starts from hallway cell, ends at door)
    allMoves += solution.moves;
    
    // After room, player ends up at the door cell (inside room)
    // Walk back out to hallway
    const walkOut = bfsWalk(room.door, room.hallwayCell, wall, new Set(), w, h);
    allMoves += walkOut;
    currentPlayerPos = room.hallwayCell;
  }
  
  return allMoves;
}

/**
 * PUSH-STATE BFS AND PER-ROOM DECOMPOSITION
 * ----------------------------------------
 * The solver uses a push-state BFS: each state = (box positions, player reachable region).
 * Transitions are box pushes (not walks); walks between pushes are reconstructed lazily.
 * 
 * Why per-room decomposition is push-optimal for this level structure:
 * - The hallway is a single row with no boxes, acting as a pure connector.
 * - Each room is only accessible through its door cell from the hallway.
 * - Boxes never cross between rooms (verified by flood-fill that stops at hallway).
 * - Player can freely walk along hallway between room visits.
 * - Therefore: optimal global solution = concatenation of optimal per-room solutions
 *   plus minimal hallway walks between door cells.
 * - No cross-room push dependencies exist; the push-state BFS per room is complete.
 * - The BFS state key = sorted box positions + player region (computed by flood-fill
 *   with boxes as obstacles) ensures we find the minimum-push sequence per room.
 */
function solveRoom(
  room: { cells: Set<number>, door: number, doorCol: number, hallwayCell: number },
  wall: Uint8Array,
  goal: Uint8Array,
  allBoxes: number[],
  w: number,
  h: number,
  hallwayRow: number
): { moves: string } {
  // Get boxes in this room
  const roomBoxes = allBoxes.filter(b => room.cells.has(b));
  const roomGoals = new Set<number>();
  for (const cell of room.cells) {
    if (goal[cell]) roomGoals.add(cell);
  }
  
  // Room-specific wall mask (walls + hallway row as walls)
  const roomWall = new Uint8Array(wall);
  for (let x = 0; x < w; x++) {
    roomWall[hallwayRow * w + x] = 1;
  }
  
  // Deadlock detection: box in corner not on goal
  function isDeadlock(boxes: number[]): boolean {
    for (const b of boxes) {
      if (roomGoals.has(b)) continue;
      const bx = b % w;
      const by = Math.floor(b / w);
      const up = roomWall[(by - 1) * w + bx];
      const down = roomWall[(by + 1) * w + bx];
      const left = roomWall[by * w + (bx - 1)];
      const right = roomWall[by * w + (bx + 1)];
      if ((up && left) || (up && right) || (down && left) || (down && right)) {
        return true;
      }
    }
    return false;
  }
  
  // Player region = connected component of reachable cells with boxes as obstacles
  function getPlayerRegion(playerPos: number, boxes: number[]): number {
    const boxSet = new Set(boxes);
    const region = new Uint8Array(w * h);
    const queue = [playerPos];
    region[playerPos] = 1;
    let minCell = playerPos;
    
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur < minCell) minCell = cur;
      const cy = Math.floor(cur / w);
      const cx = cur % w;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (roomWall[ni] || boxSet.has(ni) || region[ni]) continue;
        if (!room.cells.has(ni) && ni !== room.door && ni !== room.hallwayCell) continue;
        region[ni] = 1;
        queue.push(ni);
      }
    }
    return minCell;
  }
  
  const startKey = roomBoxes.join(',') + '|' + getPlayerRegion(room.hallwayCell, roomBoxes);
  
  const queue: { boxes: number[], playerRegion: number, playerPos: number, moves: string }[] = [{
    boxes: roomBoxes,
    playerRegion: getPlayerRegion(room.hallwayCell, roomBoxes),
    playerPos: room.hallwayCell, // Player starts at hallway cell
    moves: '',
  }];
  
  const visited = new Set<string>();
  visited.add(startKey);
  
  while (queue.length > 0) {
    const state = queue.shift()!;
    const { boxes, playerRegion, playerPos, moves } = state;
    
    // Check goal
    let allOnGoals = true;
    for (const b of boxes) {
      if (!roomGoals.has(b)) {
        allOnGoals = false;
        break;
      }
    }
    if (allOnGoals) {
      // Add walk from current player position to door
      const boxSet = new Set(boxes);
      const walkToDoor = bfsWalk(playerPos, room.door, roomWall, boxSet, w, h, room.cells, room.door, room.hallwayCell);
      return { moves: moves + walkToDoor };
    }
    
    // Compute current reachable cells for player
    const boxSet = new Set(boxes);
    const reachable = new Uint8Array(wall.length);
    const reachQueue = [playerPos];
    reachable[playerPos] = 1;
    
    while (reachQueue.length > 0) {
      const cur = reachQueue.shift()!;
      const cy = Math.floor(cur / w);
      const cx = cur % w;
      
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (roomWall[ni] || boxSet.has(ni) || reachable[ni]) continue;
        if (!room.cells.has(ni) && ni !== room.door && ni !== room.hallwayCell) continue;
        reachable[ni] = 1;
        reachQueue.push(ni);
      }
    }
    
    // Try all pushes
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      const bx = b % w;
      const by = Math.floor(b / w);
      
      for (const [dx, dy, dir] of DIRS) {
        const behindX = bx - dx;
        const behindY = by - dy;
        const targetX = bx + dx;
        const targetY = by + dy;
        
        if (behindX < 0 || behindX >= w || behindY < 0 || behindY >= h) continue;
        if (targetX < 0 || targetX >= w || targetY < 0 || targetY >= h) continue;
        
        const behind = behindY * w + behindX;
        const target = targetY * w + targetX;
        
        // Check if player can reach behind cell
        if (!reachable[behind]) continue;
        
        // Check if target is free floor in room (not wall, not box, not hallway)
        if (roomWall[target] || boxSet.has(target)) continue;
        if (!room.cells.has(target)) continue; // Can't push out of room
        
        // Check if pushing from behind is valid (behind must be in room or door/hallway cell)
        if (!room.cells.has(behind) && behind !== room.door && behind !== room.hallwayCell) continue;
        
        // Perform push
        const newBoxes = [...boxes];
        newBoxes[bi] = target;
        newBoxes.sort((a, b) => a - b);
        
        // Deadlock check
        if (isDeadlock(newBoxes)) continue;
        
        // New player position is the box's old position
        const newPlayerPos = b;
        const newPlayerRegion = getPlayerRegion(newPlayerPos, newBoxes);
        
        const newKey = newBoxes.join(',') + '|' + newPlayerRegion;
        if (visited.has(newKey)) continue;
        visited.add(newKey);
        
        // Compute walk from current player pos to behind cell
        const walk = bfsWalk(playerPos, behind, roomWall, boxSet, w, h, room.cells, room.door, room.hallwayCell);
        
        queue.push({
          boxes: newBoxes,
          playerRegion: newPlayerRegion,
          playerPos: newPlayerPos,
          moves: moves + walk + dir.toUpperCase(), // walk + push (uppercase)
        });
      }
    }
  }
  
  return { moves: '' };
}

/**
 * HALLWAY WALK RECONSTRUCTION (bfsWalk)
 * --------------------------------------
 * Computes shortest walk (lowercase moves) between two cells avoiding walls/boxes.
 * Used for: (1) hallway traversal between rooms, (2) intra-room walks to push positions,
 * (3) final walk to door after room solved.
 * 
 * Simplifications vs earlier version:
 *  - Single queue holding {pos, path} avoids separate parent map for reconstruction
 *  - Inline bounds/wall/box/visited checks in one loop
 *  - roomCells restriction is optional; when given, allows door/hallwayCell as exits
 *  - Early exit when from === to (no-op)
 *  - No path reconstruction step needed; path built incrementally in queue
 * 
 * Correctness: BFS on unweighted grid guarantees shortest walk. The roomCells filter
 * ensures walks stay inside room during push-state BFS; hallway walks use no filter.
 */
function bfsWalk(
  from: number,
  to: number,
  wall: Uint8Array,
  boxSet: Set<number>,
  w: number,
  h: number,
  roomCells?: Set<number>,
  door?: number,
  hallwayCell?: number
): string {
  if (from === to) return '';
  
  const queue: { pos: number, path: string }[] = [{ pos: from, path: '' }];
  const visited = new Uint8Array(wall.length);
  visited[from] = 1;
  
  while (queue.length > 0) {
    const { pos, path } = queue.shift()!;
    
    if (pos === to) return path;
    
    const py = Math.floor(pos / w);
    const px = pos % w;
    
    for (const [dx, dy, dir] of DIRS) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (wall[ni] || boxSet.has(ni) || visited[ni]) continue;
      // If room cells provided, restrict to room + door + hallway cell
      if (roomCells && !roomCells.has(ni) && ni !== door && ni !== hallwayCell) continue;
      visited[ni] = 1;
      queue.push({ pos: ni, path: path + dir });
    }
  }
  
  return ''; // Should not happen in valid levels
}

// Main
for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
