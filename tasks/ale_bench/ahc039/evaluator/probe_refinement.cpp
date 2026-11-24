#include <algorithm>
#include <array>
#include <iostream>
#include <random>

constexpr int grid = 40;
constexpr int side = 100000;

struct Rect { int left, bottom, right, top; };
int prefix[grid + 1][grid + 1]{};

int score(Rect r) {
    return prefix[r.right][r.top] - prefix[r.left][r.top]
         - prefix[r.right][r.bottom] + prefix[r.left][r.bottom];
}

int boundary(int i) { return i * side / grid; }

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n;
    if (!(std::cin >> n)) return 0;
    for (int i = 0; i < 2 * n; ++i) {
        int x, y;
        std::cin >> x >> y;
        const int col = std::min(grid - 1, x * grid / side);
        const int row = std::min(grid - 1, y * grid / side);
        prefix[col + 1][row + 1] += i < n ? 1 : -1;
    }
    for (int x = 1; x <= grid; ++x)
        for (int y = 1; y <= grid; ++y)
            prefix[x][y] += prefix[x - 1][y] + prefix[x][y - 1] - prefix[x - 1][y - 1];

    Rect best{0, 0, grid, grid};
    auto consider = [&](Rect r) { if (score(r) > score(best)) best = r; };
    // Choose the best cell following a fixed scan order.
    for (int x = 0; x < grid; ++x)
        for (int y = 0; y < grid; ++y)
            consider({x, y, x + 1, y + 1});
    // Hill-climb one boundary at a time from the greedy solution.
    for (;;) {
        const Rect current = best;
        for (int boundaryIndex = 0; boundaryIndex < 4; ++boundaryIndex) {
            for (int delta : {-1, 1}) {
                Rect next = current;
                std::array<int*, 4> edges{&next.left, &next.bottom, &next.right, &next.top};
                *edges[boundaryIndex] += delta;
                if (next.left >= 0 && next.bottom >= 0 && next.right <= grid && next.top <= grid &&
                    next.left < next.right && next.bottom < next.top) consider(next);
            }
        }
        if (score(best) == score(current)) break;
    }
    const int x0 = boundary(best.left), y0 = boundary(best.bottom);
    const int x1 = boundary(best.right) - (best.right != grid);
    const int y1 = boundary(best.top) - (best.top != grid);
    std::cout << "4\n" << x0 << ' ' << y0 << '\n' << x1 << ' ' << y0 << '\n'
              << x1 << ' ' << y1 << '\n' << x0 << ' ' << y1 << '\n';
}
