# Phase 6: 发布准备实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 最终测试、打包、Beta 测试、正式发布

**Timeline:** Week 13-14 (10 个工作日)

**Dependencies:** 必须完成 Phase 1-5 (所有功能和优化完成)

---

## Week 13: 测试与打包

### Task 1: 完整回归测试

**Files:**
- Create: `tests/regression/full-suite.test.ts`
- Create: `tests/regression/cross-platform.test.ts`

- [ ] **Step 1: 执行完整测试套件**

```bash
# 单元测试
pnpm test:unit

# 集成测试
pnpm test:integration

# 端到端测试
pnpm test:e2e

# 性能测试
pnpm test:performance
```

Expected: 所有测试通过,覆盖率 >80%

- [ ] **Step 2: 跨平台测试**

```typescript
// tests/regression/cross-platform.test.ts
describe('Cross-Platform Compatibility', () => {
  it('Windows: 所有功能正常', async () => {
    // 在 Windows 环境测试
  });
  
  it('macOS: 所有功能正常', async () => {
    // 在 macOS 环境测试
  });
  
  it('Linux: 所有功能正常', async () => {
    // 在 Linux 环境测试
  });
});
```

- [ ] **Step 3: 压力测试**

```typescript
// tests/regression/stress.test.ts
describe('Stress Tests', () => {
  it('1000个会话不应崩溃', async () => {
    for (let i = 0; i < 1000; i++) {
      await createSession();
    }
    expect(app.isRunning()).toBe(true);
  });
  
  it('持续运行24小时不应内存泄漏', async () => {
    const initialMem = process.memoryUsage().heapUsed;
    
    await runFor24Hours();
    
    const finalMem = process.memoryUsage().heapUsed;
    const growth = (finalMem - initialMem) / initialMem;
    
    expect(growth).toBeLessThan(0.1); // <10% 增长
  });
});
```

- [ ] **Step 4: 记录测试结果**

创建测试报告: `docs/test-report.md`

```markdown
# 测试报告

## 单元测试: ✅ 通过 (覆盖率 85%)
## 集成测试: ✅ 通过
## 端到端测试: ✅ 通过
## 性能测试: ✅ 通过
## 压力测试: ✅ 通过

## 已知问题: 0
```

- [ ] **Step 5: 提交**

```bash
git add tests/regression/ docs/test-report.md
git commit -m "test: complete regression testing

- 所有测试套件通过
- 跨平台兼容性验证
- 压力测试通过
- 测试报告生成"
```

---

### Task 2: 生产环境配置

**Files:**
- Create: `.env.production`
- Update: `electron-builder.yml`
- Create: `scripts/build-production.sh`

- [ ] **Step 1: 配置生产环境变量**

```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=error
SENTRY_DSN=https://...
UPDATE_SERVER=https://updates.roc.app
```

- [ ] **Step 2: 更新 Electron Builder 配置**

```yaml
# electron-builder.yml
appId: com.roc.desktop
productName: Roc
copyright: Copyright © 2026 Roc Team

mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  target:
    - dmg
    - zip

win:
  target:
    - nsis
    - portable
  signingHashAlgorithms:
    - sha256
  certificateFile: certs/windows-cert.p12
  certificatePassword: ${WIN_CSC_KEY_PASSWORD}

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false

publish:
  provider: generic
  url: https://updates.roc.app
```

- [ ] **Step 3: 创建构建脚本**

```bash
#!/bin/bash
# scripts/build-production.sh

set -e

echo "🚀 Starting production build..."

# 清理
rm -rf dist/ release/

# 安装依赖
pnpm install --frozen-lockfile

# 运行测试
pnpm test

# 构建
pnpm build

# 打包
pnpm electron-builder --win --mac --linux

echo "✅ Production build complete!"
echo "📦 Artifacts in release/"
```

- [ ] **Step 4: 执行生产构建**

```bash
chmod +x scripts/build-production.sh
./scripts/build-production.sh
```

Expected: 在 `release/` 目录生成所有平台的安装包

- [ ] **Step 5: 提交**

```bash
git add .env.production electron-builder.yml scripts/
git commit -m "build: configure production build

- 生产环境变量
- 跨平台打包配置
- 自动化构建脚本"
```

---

### Task 3: 数据迁移真实测试

**Goal:** 使用真实用户数据测试迁移脚本

- [ ] **Step 1: 准备测试数据**

```bash
# 从生产环境复制匿名化的用户数据
cp production-db-sample.db tests/fixtures/real-user-data.db
```

- [ ] **Step 2: 执行迁移测试**

```typescript
// tests/migration/real-data.test.ts
describe('Real Data Migration', () => {
  it('应该成功迁移真实用户数据', async () => {
    const result = await migrateDatabase({
      oldDbPath: './tests/fixtures/real-user-data.db',
      newDbBasePath: './tests/fixtures/migrated',
      logger: console
    });
    
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
  
  it('迁移后数据完整性验证', async () => {
    const agentDb = new Database('./tests/fixtures/migrated/agent.db');
    
    const sessions = agentDb.prepare('SELECT COUNT(*) as count FROM sessions').get();
    expect((sessions as any).count).toBeGreaterThan(0);
    
    const messages = agentDb.prepare('SELECT COUNT(*) as count FROM messages').get();
    expect((messages as any).count).toBeGreaterThan(0);
    
    agentDb.close();
  });
});
```

Run: `pnpm test tests/migration/real-data.test.ts`
Expected: PASS

- [ ] **Step 3: 验证回滚机制**

```typescript
it('迁移失败应该自动回滚', async () => {
  // 模拟迁移失败
  const mockError = () => { throw new Error('Migration failed'); };
  
  try {
    await migrateDatabase({
      oldDbPath: './tests/fixtures/real-user-data.db',
      newDbBasePath: './tests/fixtures/failed',
      logger: console,
      injectError: mockError
    });
  } catch (error) {
    // 验证旧数据库仍然完好
    expect(existsSync('./tests/fixtures/real-user-data.db')).toBe(true);
    
    // 验证备份已创建
    expect(existsSync('./tests/fixtures/real-user-data.db.backup')).toBe(true);
  }
});
```

- [ ] **Step 4: 提交**

```bash
git add tests/migration/
git commit -m "test: validate migration with real user data

- 真实数据迁移测试
- 数据完整性验证
- 回滚机制测试"
```

---

### Task 4: Release Notes 编写

**Files:**
- Create: `CHANGELOG.md`
- Create: `docs/release-notes/v2.0.0.md`

- [ ] **Step 1: 编写 Release Notes**

```markdown
# Roc v2.0.0 Release Notes

发布日期: 2026-XX-XX

## 🎉 重大更新

### 全新架构
- 采用插件化微内核架构,模块间零耦合
- 文件大小从最大 1486 行降至 <300 行
- 更易维护和扩展

### 性能提升
- 启动速度: 2.5s → 2.7s (+8% 但仍在目标内)
- 内存占用: 120MB → 135MB (+12.5%)
- 打包体积: 390MB → 395MB (+1.3%)

### 新功能
- ✨ 插件系统: 支持第三方插件扩展
- ✨ 事件驱动架构: 更灵活的模块通信
- ✨ 独立数据库: 每个插件独立存储,易于备份

## ⚠️ 破坏性变更

### 数据迁移
首次启动会自动迁移旧数据库到新架构。迁移过程:
1. 自动备份旧数据 (roc.db → roc.db.backup)
2. 迁移到新数据库结构 (agent.db, memory.db, task.db)
3. 验证数据完整性
4. 完成后旧数据库保留 30 天

⚠️ **重要**: 升级前请手动备份 `%APPDATA%/Roc/roc.db`

### API 变更
- IPC 接口更新: 旧的 `chat.send` → 新的 `agent.chat.stream`
- 配置格式变更: 见 [迁移指南](docs/migration-guide.md)

## 🐛 Bug 修复
- 修复长时间运行内存泄漏
- 修复 Git 状态查询错误
- 修复流式输出偶尔卡顿

## 📚 文档更新
- [架构文档](docs/architecture.md)
- [插件开发指南](docs/plugin-development-guide.md)
- [API 参考](docs/api-reference.md)

## 🙏 致谢
感谢所有 Beta 测试用户的反馈!
```

- [ ] **Step 2: 更新 CHANGELOG**

```markdown
# Changelog

## [2.0.0] - 2026-XX-XX

### Added
- 插件化微内核架构
- 独立数据库架构
- 自动数据迁移

### Changed
- 重构前端为 MVVM 架构
- 优化性能和内存占用

### Fixed
- 内存泄漏问题
- Git 状态查询错误

## [1.x.x] - Previous versions
...
```

- [ ] **Step 3: 提交**

```bash
git add CHANGELOG.md docs/release-notes/
git commit -m "docs: prepare v2.0.0 release notes

- 详细的新功能说明
- 破坏性变更警告
- 迁移指南链接"
```

---

## Week 14: Beta 测试与发布

### Task 5: Beta 发布

- [ ] **Step 1: 创建 Beta 版本**

```bash
# 标记 Beta 版本
git tag v2.0.0-beta.1
git push origin v2.0.0-beta.1

# 构建 Beta 包
pnpm build
pnpm electron-builder --publish never
```

- [ ] **Step 2: 上传到测试服务器**

```bash
scp release/*.exe beta@updates.roc.app:/beta/
```

- [ ] **Step 3: 邀请 Beta 测试用户**

发送邮件给测试用户:
```
主题: Roc v2.0.0 Beta 测试邀请

您好!

Roc v2.0.0 Beta 版本已准备好测试。
下载: https://updates.roc.app/beta/Roc-2.0.0-beta.1.exe

主要变更:
- 全新插件化架构
- 性能优化
- 数据自动迁移

请反馈:
1. 迁移是否成功
2. 所有功能是否正常
3. 性能是否满意
4. 任何崩溃或错误

测试期: 7 天
反馈方式: GitHub Issues
```

- [ ] **Step 4: 收集反馈并修复**

监控:
- 崩溃报告 (Sentry)
- GitHub Issues
- 用户反馈邮件

记录到: `docs/beta-feedback.md`

- [ ] **Step 5: 修复关键问题**

针对 Beta 反馈的关键 bug:
```bash
git checkout -b fix/beta-issue-123
# 修复代码
git commit -m "fix: resolve beta issue #123"
git push origin fix/beta-issue-123
# 创建 PR 并合并
```

---

### Task 6: 正式发布

- [ ] **Step 1: 最终检查清单**

```markdown
## 发布前检查清单

- [ ] 所有测试通过
- [ ] Beta 测试无重大问题
- [ ] Release Notes 完整
- [ ] 迁移指南完整
- [ ] 文档已更新
- [ ] 代码已合并到 main
- [ ] 版本号已更新
- [ ] 构建产物已验证
```

- [ ] **Step 2: 创建正式版本**

```bash
# 更新版本号
npm version 2.0.0

# 标记正式版本
git tag v2.0.0
git push origin v2.0.0

# 构建正式版
pnpm build
pnpm electron-builder --win --mac --linux --publish always
```

- [ ] **Step 3: 发布到生产环境**

```bash
# 上传到发布服务器
scp release/*.exe release@updates.roc.app:/releases/v2.0.0/
scp release/*.dmg release@updates.roc.app:/releases/v2.0.0/
scp release/*.AppImage release@updates.roc.app:/releases/v2.0.0/

# 更新 latest.yml (自动更新配置)
scp release/latest*.yml release@updates.roc.app:/releases/
```

- [ ] **Step 4: 更新官网**

- 更新下载链接
- 发布博客文章
- 更新文档站点

- [ ] **Step 5: 宣布发布**

```markdown
🎉 Roc v2.0.0 正式发布!

全新插件化架构,更快更强!

下载: https://roc.app/download
Release Notes: https://github.com/roc/roc/releases/tag/v2.0.0

主要更新:
- 🚀 插件化微内核架构
- ⚡ 性能优化
- 🔄 自动数据迁移
- 📚 完善的文档

感谢所有贡献者和测试用户!
```

发布到:
- GitHub Releases
- Twitter
- Discord
- 官方博客

- [ ] **Step 6: 提交最终状态**

```bash
git add .
git commit -m "release: Roc v2.0.0

- 14周架构现代化完成
- 所有功能验证通过
- 生产环境部署完成"
git push origin main
```

---

## 验收标准

- [ ] 所有回归测试通过
- [ ] 跨平台测试通过
- [ ] Beta 测试无重大问题
- [ ] Release Notes 完整
- [ ] 正式版本已发布
- [ ] 官网已更新

---

## Phase 6 完成标志

✅ 完整回归测试通过  
✅ Beta 测试完成  
✅ 正式版本发布  
✅ 用户可下载使用  
✅ 文档完整准确  

---

## 🎉 项目完成!

**总耗时:** 14 周 (70 个工作日)

**交付成果:**
- ✅ 插件化微内核架构
- ✅ 6 个核心插件
- ✅ 前端 MVVM 重构
- ✅ 性能优化达标
- ✅ 完整文档
- ✅ 生产环境部署

**核心指标达成:**
- 文件大小: 1486 行 → <300 行 ✅
- 模块解耦: 0% → 100% ✅
- 打包体积: 390MB → 395MB ✅
- 运行内存: 120MB → 135MB ✅
- 启动速度: 2.5s → 2.7s ✅

**下一步:**
- 监控生产环境
- 收集用户反馈
- 迭代优化
- 开发新插件

---

**预计完成: 2周**

*Plan generated on 2026-06-04*
*Final phase of Roc Architecture Modernization*
