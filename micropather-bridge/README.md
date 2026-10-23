# dsh-micropather

把 [MicroPather](https://github.com/leethomason/MicroPather)（C++ A* 寻路库）包装成 DSH 工具。
库本身没有 IPC 接口，所以这里内置一个用**同一份 `micropather.cpp`** 编译出来的 CLI，
插件负责把网格序列化进去、把路径解析回来。

## 工具

| 工具 | 作用 |
|---|---|
| `micropather_solve` | 给定字符网格 + 起点/终点（可选八方向），返回路径点、步数与代价 |
| `micropather_info` | 求解器自检（3x3 跑一遍） |

## 用法要点

- `grid` 是字符串数组，`.` 可走、`#` 阻挡（其它字符按可走处理），所有行等长。
- `start`/`goal` 写 `"x,y"`（x=列，y=行，0 起），也接受 `[x,y]` 或 `{x,y}`。
- `diagonal: true` 允许八方向，斜向代价 √2，且**不允许贴角穿越**。

## 构建（需要改 CLI 时）

```powershell
# w64devkit: https://github.com/skeeto/w64devkit
g++ -O2 -std=c++17 -static -I lib lib\solve_cli.cpp lib\micropather.cpp -o bin\micropather_solve.exe
```

`lib/micropather.cpp` / `micropather.h` 来自上游 `MicroPather-master`，未改动。
