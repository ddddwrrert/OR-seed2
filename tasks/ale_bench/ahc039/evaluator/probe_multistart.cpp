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
    // Deterministic RNG makes the same panel reproducible across runs.
    std::mt19937 rng(7639);
    for (int i = 0; i < 12000; ++i) {
        int x = rng() % grid, y = rng() % grid;
        int w = 1 + rng() % (grid - x), h = 1 + rng() % (grid - y);
        consider({x, y, x + w, y + h});
    }
    const int x0 = boundary(best.left), y0 = boundary(best.bottom);
    const int x1 = boundary(best.right) - (best.right != grid);
    const int y1 = boundary(best.top) - (best.top != grid);
    std::cout << "4\n" << x0 << ' ' << y0 << '\n' << x1 << ' ' << y0 << '\n'
              << x1 << ' ' << y1 << '\n' << x0 << ' ' << y1 << '\n';
}
