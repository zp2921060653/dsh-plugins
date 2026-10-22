---
name: wukong-trainer-re
description: 黑神话·悟空（UE5 + C# 托管层）外部修改器的完整逆向与制作方法论 —— 属性数组公式、属性ID表、五类功能的实现手法（数值写/冻结/代码补丁/钩访问器/引擎参数）、AOB+代码洞穴注入流程，以及 7 个实战踩坑。状态：未完成（WIP），已覆盖属性/坐标/掉落，灵蕴·无敌·速度待补。
whenToUse: 需要给黑神话·悟空（b1-Win64-Shipping.exe）做修改器、理解其属性系统、定位"改了没反应"的原因、或要把某个 CE/FLiNG 风格修改器的技术复现出来时使用。也适用于同架构的 UE5 + USharp(C#) 游戏：属性以 float 数组按枚举索引存放、金钱/点数类数值不常驻内存。
metadata:
  version: "0.1"
  status: "未完成 / WIP"
  game: "Black Myth: Wukong (b1-Win64-Shipping.exe, UE 5.0)"
---

# 黑神话·悟空 修改器逆向制作法（WIP）

> **状态：未完成。** 第 3 节表格标注了每类功能的完成度。未完成项已在第 6 节列出 TODO。
> 所有结论均在 v1.0.x（UE 5.0.0，exe 728 MB）实机验证。

## 0. 一句话总纲

**先分清改哪一层，再选手法。** 同一个"数值"，在三层里的改法完全不同：

```
引擎层 (UE5 原生)   坐标/Actor/组件      → 外部读写可行
玩法层 (C#/USharp)  属性数组/钱包/结算    → 只在函数被调用时暴露，必须挂钩子
持久层 (protobuf)   存档 .sav            → 解析 pb，改动最大
```

选错层 = 怎么试都没反应（灵蕴上绕了很久就是这个原因）。

## 1. 属性系统：一条 lea 决定一切

`GetAttributeFloat(owner, index)` 的函数体：

```asm
0F 86 * * 00 00     jbe  越界检查
48 8D 44 88 20      lea  rax,[rax+rcx*4+0x20]   ; 地址 = owner + 0x20 + index*4
F3 0F 10 00         movss xmm0,[rax]            ; 读 float
```

**公式**：`addr = attrArrayBase + 0x20 + enumID * 4`

### 属性 ID 表（实测）

| 属性 | ID | 偏移 | 备注 |
|---|---|---|---|
| HpMax | 1 | +0x24 | **派生值**，游戏会重算 |
| MpMax | 2 | +0x28 | 同上 |
| StaminaMax | 8 | +0x40 | 同上 |
| **HpMaxBase** | **101** | **+0x1B4** | **上限的源头，改它才生效** |
| MpMaxBase | 102 | +0x1B8 | |
| StaminaMaxBase | 108 | +0x1D0 | |
| Hp | 151 | +0x27C | 当前血量 |
| Mp | 152 | +0x280 | |
| Atk | 153 | +0x284 | |
| Def | 154 | +0x288 | |
| Stamina | 158 | +0x298 | |
| Pevalue（棍势） | 191 | +0x31C | |
| ExpDropAddition | 198 | +0x338 | 经验/灵蕴掉落加成 |
| SpiritDropAddition | 199 | +0x33C | 掉落加成 |
| CommDropAddition | 203 | +0x34C | 掉落率加成 |

## 2. 五类功能 × 五种手法

| 类型 | 例子 | 手法 | 需注入 |
|---|---|---|---|
| A 静态数值 | 攻击/防御/上限/掉落加成 | 直接写属性数组 | 否 |
| B 持续数值 | 无限生命/法力/体力/棍势 | 33ms 冻结重写 | 否 |
| C 判定逻辑 | 无敌、100%掉宝 | 代码补丁 | 是 |
| D 隐藏对象 | 灵蕴、技能点、遗物点 | 钩访问器拿指针 | 是 |
| E 引擎参数 | 移速/跳跃/游戏速度 | 改 setter 或常量 | 是 |

### 模板

A/B：
```
addr = base + 0x20 + id*4
Write(addr, v)                  // 一次性
loop 33ms: Write(addr, v)       // 冻结
```

C - 100% 掉宝（4 字节）：
```asm
aobdropcheck:
  db B0 01 C3 90        ; mov al,1 ; ret  → 判定永远通过
```

C - 无敌（代码洞穴）：
```asm
newmem:
  cmp [godmode],1
  jne code
  mov rcx,player_actor
  cmp [rcx],r12         ; 被打的是不是玩家
  jne code
  mov eax,1
  jmp return
```

D - 灵蕴钱包：
```asm
; 定位：48 8B 40 20 4C 63 C0
newmem:
  mov r8d,[edit_soul]
  cmp r8d,0
  jle code
  mov [edit_soul],0
  mov [rax+20],r8d
code:
  mov rax,[rax+20]
  movsxd r8,eax
```

## 3. 完成度（WIP 标记）

| 功能 | 路线 | 状态 |
|---|---|---|
| 编辑生命上限 | A（HpMaxBase 101） | ✅ 实机验证 |
| 编辑攻击/防御 | A | ✅ 面板显示生效 |
| 掉落三项加成 | A | ✅ 掉落明显变多 |
| 坐标/传送 | 引擎层 double3（根组件 +0x280） | ✅ 位移成功 |
| 无限生命/法力/体力/棍势 | B | 🟡 引擎支持，未接 GUI |
| 100% 掉宝率 | C | 🟡 补丁已提取，未实施 |
| 无敌模式 | C | 🟡 脚本已提取，缺 player_actor 稳定获取 |
| 灵蕴/技能点/遗物点 | D | 🟡 钩子框架跑通，未命中正确函数 |
| 速度/跳跃/游戏速度 | E | ⬜ 未开始 |


## 3.5 属性钩子实施方案（已设计，未实施）

> 目标：改攻击/上限/无限生命**不需要任何重定位**。当前用「外部写值 + 2 秒看门狗自动重定位」过渡。

### 为什么不能直接 hook 那条 lea（实测）

- 该 `lea` 在 exe 里有 **10 份内联副本**
  （0x140B5AEC8 / 0x140B5BA7C / 0x140B5BAAB / 0x140B5BB8C / 0x140B5BBBB / 0x140B5BD4C / 0x140B5BE0C / 0x140B5BE3B / 0x140B5BFD4 / 0x140B5C0BC / 0x140B5CFFE / 0x140B5D060）
- 第一处装计数探针：**4.5 秒零命中**
- 前 4 处同时下硬件执行断点：**4 秒零命中**
- 结论：HUD/面板的血量显示**不走这个 getter**，而是内联直接读数组

### FLiNG 的双钩子设计

| 钩子 | 作用 | 关键指令 |
|---|---|---|
| B（aobgetplayerpevalue） | 玩家识别 | `mov [isplayerstat],1` + `mov [pevalue_enum],edx`，并在 `[rsi+0x10]` 捕获 player_actor |
| A（aobgetfloatattribute） | 属性访问 + 写值 | 当 `isplayerstat==1 && pevalue_enum==ecx` 时记下 `PlayerAttributesPtr`，此后每次读都强制写 |

要点：玩家识别靠**时序关系**（B 标记 → 紧接着 A 被调用且 ID 匹配），不靠数值特征。

### 实施步骤

1. **解决 `s1.1` 语法**：CE 的 AA 不支持它 → 用宽松 AOB 扫描拿到地址、读实际字节、在脚本里用 `db` 写死
2. **确定热副本**：开面板 → 对 10 个副本逐个下硬件执行断点（一次 4 个）→ 刷新面板看谁命中
3. **装钩子 B**：验证 `isplayerstat` 会短暂变 1（顺便得到 player_actor → 可做无敌）
4. **装钩子 A**：先只捕获 `PlayerAttributesPtr`（不写值），确认稳定
5. **加写值**：`mov [rbx+rax*4],edx`（rbx=数组首址，rax=属性ID）
6. **验证**：换场景后仍有效（关键：证明不需要重定位）
7. **回滚**：按已知地址写回原始字节（补丁已抹掉特征码，不能靠重扫）

### 简化方案（Plan B，单钩子）

用 `DEF(154) > 320` 做玩家判据（玩家 455，敌人固定 300），省掉钩子 B：

@@@asm
mov r8, rax          ; rax = base+0x20+index*4
mov r9d, ecx
shl r9, 2
sub r8, r9           ; r8 = base+0x20
movss xmm2, [r8+616] ; DEF = base+0x20+154*4
comiss xmm2, [def_thr]; 320.0
jbe skip
mov r9d, [atk_value]
mov [r8+612], r9d    ; ATK = base+0x20+153*4
skip:
@@@

风险：DEF>320 的 BOSS 会被误改（可叠加 HP 上限判据）。

## 4. 从零复现流程

1. **找值**：CE 搜已知数值（如攻击 152）→ 换装备 → 再搜 → 收敛
2. **找函数**：F5「找出是什么访问了它」→ 找 `movss xmm0,[rax]` → 反汇编找 `lea rax,[rax+rcx*4+0x20]`
3. **建 ID 表**：函数入口下断，看 ecx(ID) / xmm0(值)，逐项标注
4. **写 AOB**：变的部分写 `*`，**必须验证全 exe 唯一命中**
5. **写 AA 脚本**：aobscan → alloc 洞穴 → 先执行被覆盖指令 → 自己的逻辑 → jmp 回
6. **自己注入**：OpenProcess → VirtualAllocEx(EXECUTE_READWRITE) → 写桩 → VirtualProtectEx(函数头) → 写 E9 rel32 → FlushInstructionCache
7. **验证与回滚**：一次只加一个功能；保存原始字节；崩了先还原

## 5. 七个实战坑

| # | 坑 | 现象 | 正解 |
|---|---|---|---|
| 1 | 改派生值 | 改 HpMax(+0x24) 无反应 | 改 **HpMaxBase(101)=+0x1B4** |
| 2 | 按值扫钱包 | i32/i64/f32/f64 全 0 命中 | 钱包只在钩子里经 rax 暴露 |
| 3 | 数值唯一≠钱包 | 命中连号表 725207/725208/725209 | 用"加钱前后差分"验证 |
| 4 | 属性块会漂移 | 20 分钟换 5 个地址 | 每次重新定位，或钩子拿指针 |
| 5 | shell 启动 GUI | 进程 15 秒后消失 | 命令结束清理进程树 → `Win32_Process.Create` |
| 6 | CE autoAssemble | 返回 nil 无提示 | **不能带 `[ENABLE]` 段头** |
| 7 | AOB 自毁 | 打补丁后重扫找不到 | 按**已知地址**写回原始字节 |

## 6. TODO（未完成）

- [ ] B 类接 GUI（无限生命/法力/体力/棍势）—— 复用 33ms 冻结即可
- [ ] 100% 掉宝补丁落地（4 字节，风险最低）
- [ ] 灵蕴：需找到"真正加钱"的函数（不是读钱包那个）；验证方法：改完看余额变化
- [ ] 技能点/遗物点：按 FLiNG 偏移直接写（技能点 `[rsi+4C]`，遗物点 `[rcx+24]`）
- [ ] 无敌：用 aobplayerpawn 钩子稳定拿 player_actor
- [ ] **属性钩子**：按 3.5 节实施（双钩子或 Plan B），做完可去掉重定位依赖
- [ ] 速度/跳跃/游戏速度：找 setter 或常量
- [ ] 补齐 FLiNG 的 44 项对照表与逐项验证记录

## 7. 参考实现

- FLiNG（风灵月影）修改器把 AA 脚本以字符串嵌在 .rdata，可直接静态提取
- 本方法配套工具：`scan.dll`（扫描/差分/写入）、`objwalk.dll`（GObjects/GNames 遍历）、`wukong-probe.dll`（只读取证）
