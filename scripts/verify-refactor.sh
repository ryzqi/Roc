#!/bin/bash
# Roc 重构验证测试脚本

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           Roc 重构自动化验证脚本                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试结果计数
PASSED=0
FAILED=0
TOTAL=0

# 测试函数
test_step() {
    local description=$1
    local command=$2

    TOTAL=$((TOTAL + 1))
    echo -n "[$TOTAL] 测试: $description ... "

    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ 通过${NC}"
        PASSED=$((PASSED + 1))
        return 0
    else
        echo -e "${RED}❌ 失败${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "阶段 1: 文件完整性检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_step "provider-config.ts 存在" \
    "test -f src/shared/types/provider-config.ts"

test_step "reasoning-parser.ts 存在" \
    "test -f src/renderer/chat/reasoning-parser.ts"

test_step "reasoning-view.tsx 存在" \
    "test -f src/renderer/chat/reasoning-view.tsx"

test_step "json-view.tsx 存在" \
    "test -f src/renderer/chat/json-view.tsx"

test_step "tool-call-view.tsx 存在" \
    "test -f src/renderer/chat/tool-call-view.tsx"

test_step "reasoning.css 存在" \
    "test -f src/renderer/styles/reasoning.css"

test_step "tool-call.css 存在" \
    "test -f src/renderer/styles/tool-call.css"

test_step "provider-adapter.ts 存在" \
    "test -f src/main/services/deep-agent/provider-adapter.ts"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "阶段 2: 代码质量检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_step "TypeScript 类型检查" \
    "pnpm typecheck"

test_step "reasoning-parser 导出检查" \
    "grep -q 'export function parseReasoningContent' src/renderer/chat/reasoning-parser.ts"

test_step "ReasoningView 组件导出" \
    "grep -q 'export function ReasoningView' src/renderer/chat/reasoning-view.tsx"

test_step "JsonView 组件导出" \
    "grep -q 'export function JsonView' src/renderer/chat/json-view.tsx"

test_step "ToolCallView 组件导出" \
    "grep -q 'export function ToolCallView' src/renderer/chat/tool-call-view.tsx"

test_step "provider-adapter 导出检查" \
    "grep -q 'export function createModelFromProviderConfig' src/main/services/deep-agent/provider-adapter.ts"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "阶段 3: 集成检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_step "chat-message-row 导入 ReasoningView" \
    "grep -q \"import.*ReasoningView.*from.*reasoning-view\" src/renderer/chat/chat-message-row.tsx"

test_step "chat-message-row 导入 ToolCallView" \
    "grep -q \"import.*ToolCallView.*from.*tool-call-view\" src/renderer/chat/chat-message-row.tsx"

test_step "样式文件导入 reasoning.css" \
    "grep -q \"reasoning.css\" src/renderer/styles/index.css"

test_step "样式文件导入 tool-call.css" \
    "grep -q \"tool-call.css\" src/renderer/styles/index.css"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "阶段 4: 文档完整性"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_step "REFACTOR_PLAN.md 存在" \
    "test -f REFACTOR_PLAN.md"

test_step "REFACTOR_SUMMARY.md 存在" \
    "test -f REFACTOR_SUMMARY.md"

test_step "REFACTOR_VERIFICATION.md 存在" \
    "test -f REFACTOR_VERIFICATION.md"

test_step "REFACTOR_COMPLETE.md 存在" \
    "test -f REFACTOR_COMPLETE.md"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                      测试结果汇总                            ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  总计: %-3d 项                                              ║\n" $TOTAL
printf "║  ${GREEN}通过: %-3d 项${NC}                                              ║\n" $PASSED
printf "║  ${RED}失败: %-3d 项${NC}                                              ║\n" $FAILED
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 所有自动化测试通过！${NC}"
    echo ""
    echo "下一步："
    echo "1. 运行 'pnpm dev' 启动开发服务器"
    echo "2. 手动测试推理和工具渲染功能"
    echo "3. 运行 'pnpm test' 执行单元测试"
    exit 0
else
    echo -e "${RED}⚠️  部分测试失败，请检查上述错误${NC}"
    exit 1
fi
