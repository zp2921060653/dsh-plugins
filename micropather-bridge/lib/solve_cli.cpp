// micropather_solve — CLI wrapper around micropather.cpp so a DSH tool can call it.
//
// Input (argv[1], UTF-8 text):
//   <W> <H>
//   <H rows, each W chars: '.' free, '#' blocked>
//   <sx> <sy> <gx> <gy>
//   <diagonal 0|1>
//
// Output (stdout): one JSON object.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

// micropather.h uses memcpy without including <cstring>; keep this include last.
#include "micropather.h"

using namespace micropather;

static const float SQRT2 = 1.41421356f;

struct GridGraph : public Graph {
  int w, h;
  bool diagonal;
  std::vector<char> blocked;

  GridGraph(int width, int height, bool diag)
      : w(width), h(height), diagonal(diag), blocked((size_t)width * height, 0) {}

  bool freeCell(int x, int y) const {
    return x >= 0 && y >= 0 && x < w && y < h && !blocked[(size_t)y * w + x];
  }

  float LeastCostEstimate(void* a, void* b) override {
    int ia = (int)(intptr_t)a, ib = (int)(intptr_t)b;
    int ax = ia % w, ay = ia / w, bx = ib % w, by = ib / w;
    int dx = abs(ax - bx), dy = abs(ay - by);
    if (diagonal) {
      int mn = dx < dy ? dx : dy;
      int mx = dx < dy ? dy : dx;
      return SQRT2 * (float)mn + (float)(mx - mn);
    }
    return (float)(dx + dy);
  }

  void AdjacentCost(void* s, MP_VECTOR<StateCost>* adj) override {
    int i = (int)(intptr_t)s, x = i % w, y = i / w;
    static const int dx4[4] = {1, -1, 0, 0}, dy4[4] = {0, 0, 1, -1};
    static const int dx8[8] = {1, -1, 0, 0, 1, 1, -1, -1};
    static const int dy8[8] = {0, 0, 1, -1, 1, -1, 1, -1};
    int n = diagonal ? 8 : 4;
    for (int k = 0; k < n; k++) {
      int dx = diagonal ? dx8[k] : dx4[k];
      int dy = diagonal ? dy8[k] : dy4[k];
      int nx = x + dx, ny = y + dy;
      if (!freeCell(nx, ny)) continue;
      if (diagonal && k >= 4 && (!freeCell(x + dx, y) || !freeCell(x, y + dy))) continue;
      StateCost sc;
      sc.state = (void*)(intptr_t)((size_t)ny * w + nx);
      sc.cost = (diagonal && k >= 4) ? SQRT2 : 1.0f;
      adj->push_back(sc);
    }
  }

  void PrintStateInfo(void* s) override { (void)s; }
};

int main(int argc, char** argv) {
  if (argc < 2) {
    printf("{\"ok\":false,\"error\":\"missing spec file\"}\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    printf("{\"ok\":false,\"error\":\"cannot open spec file\"}\n");
    return 2;
  }
  int w = 0, h = 0;
  if (!(in >> w >> h) || w <= 0 || h <= 0 || w > 4096 || h > 4096) {
    printf("{\"ok\":false,\"error\":\"bad grid size\"}\n");
    return 2;
  }
  std::vector<std::string> rows;
  rows.reserve(h);
  for (int y = 0; y < h; y++) {
    std::string row;
    if (!(in >> row)) {
      printf("{\"ok\":false,\"error\":\"missing grid row %d\"}\n", y);
      return 2;
    }
    if ((int)row.size() != w) {
      printf("{\"ok\":false,\"error\":\"row %d has %d cells, expected %d\"}\n", y, (int)row.size(), w);
      return 2;
    }
    rows.push_back(row);
  }
  int sx = 0, sy = 0, gx = 0, gy = 0, diag = 0;
  if (!(in >> sx >> sy >> gx >> gy >> diag)) {
    printf("{\"ok\":false,\"error\":\"missing start/goal/diagonal line\"}\n");
    return 2;
  }
  if (sx < 0 || sy < 0 || gx < 0 || gy < 0 || sx >= w || sy >= h || gx >= w || gy >= h) {
    printf("{\"ok\":false,\"error\":\"start or goal outside the grid\"}\n");
    return 2;
  }

  GridGraph g(w, h, diag != 0);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++)
      g.blocked[(size_t)y * w + x] = rows[y][x] == '#' ? 1 : 0;

  if (g.blocked[(size_t)sy * w + sx] || g.blocked[(size_t)gy * w + gx]) {
    printf("{\"ok\":false,\"error\":\"start or goal is blocked\"}\n");
    return 2;
  }

  MicroPather pather(&g, 1024);
  MP_VECTOR<void*> path;
  float cost = 0.0f;
  void* start = (void*)(intptr_t)((size_t)sy * w + sx);
  void* goal = (void*)(intptr_t)((size_t)gy * w + gx);
  int res = pather.Solve(start, goal, &path, &cost);

  if (res == MicroPather::NO_SOLUTION) {
    printf("{\"ok\":false,\"error\":\"no path between start and goal\"}\n");
    return 0;
  }
  if (res != MicroPather::SOLVED && res != MicroPather::START_END_SAME) {
    printf("{\"ok\":false,\"error\":\"unexpected solver result %d\"}\n", res);
    return 1;
  }

  printf("{\"ok\":true,\"cost\":%.4f,\"steps\":%d,\"same\":%s,\"path\":[",
         cost, (int)path.size(), res == MicroPather::START_END_SAME ? "true" : "false");
  for (size_t i = 0; i < path.size(); i++) {
    int idx = (int)(intptr_t)path[i];
    printf("%s[%d,%d]", i ? "," : "", idx % w, idx / w);
  }
  printf("]}\n");
  return 0;
}
