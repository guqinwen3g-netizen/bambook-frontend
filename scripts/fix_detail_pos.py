import re

file_path = '/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/ui/osCompiler/compiledProductsTemplates.tsx'
with open(file_path, 'r') as f:
    content = f.read()

# 找到 {navLevel === 'detail' && selectedProduct && (
start_idx = content.find("{navLevel === 'detail' && selectedProduct && (")

if start_idx != -1:
    # 找到它的上一行是不是 </div>
    prev_div_idx = content.rfind('</div>', 0, start_idx)
    
    # 我们要把从 start_idx 到 这个块结束的所有内容，移动到 prev_div_idx 之前！
    # 先找到这个块的结尾 }
    def find_matching_brace(s, start_idx):
        count = 1
        idx = start_idx + 1
        while count > 0 and idx < len(s):
            if s[idx] == '{':
                count += 1
            elif s[idx] == '}':
                count -= 1
            idx += 1
        return idx
    
    brace_start = content.find('{', start_idx)
    end_idx = find_matching_brace(content, brace_start)
    
    block = content[start_idx:end_idx]
    
    # block 中把 absolute inset-x-0 top-0 换成普通的 relative flex 占位！
    # 因为它在 productContentCanvasClass (flex-1) 内部，它应该是 flex-1 撑满剩余空间。
    # 我们把它改为 flex-1 min-h-0 flex overflow-visible relative
    block = block.replace(
        "absolute inset-x-0 top-0 ${isMobile ? 'bottom-0' : BAMBOOK_OS.layout.desktopMainPanelBottomEdgeClass} z-[20]",
        "flex-1 min-h-0 flex overflow-visible relative"
    )
    
    # 移除它原来在的内容
    new_content = content[:start_idx] + content[end_idx:]
    
    # 重新找到刚才那个 </div>，注意下标变了
    prev_div_idx_new = new_content.rfind('</div>', 0, start_idx)
    
    # 在 prev_div_idx_new 之前插入 block
    final_content = new_content[:prev_div_idx_new] + '\n        ' + block + '\n      ' + new_content[prev_div_idx_new:]
    
    with open(file_path, 'w') as f:
        f.write(final_content)
    print("Fixed layout!")
else:
    print("Block not found!")

