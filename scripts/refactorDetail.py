import re

file_path = '/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/ui/osCompiler/compiledProductsTemplates.tsx'
with open(file_path, 'r') as f:
    content = f.read()

# Find the end of productContentCanvasClass div.
# We know it looks like:
#           </div>
#         )}
#       </div>
#
#       {/* Mobile Options Sheet */}
# Let's find "{/* Mobile Options Sheet */}"
mobile_sheet_idx = content.find('{/* Mobile Options Sheet */}')
canvas_end_idx = content.rfind('</div>', 0, mobile_sheet_idx)

# Find the start of selectedProduct block:
selected_block_start_idx = content.find('{selectedProduct && (')
if selected_block_start_idx == -1:
    selected_block_start_idx = content.find("{navLevel === 'detail' && selectedProduct && (")

# Extract the selected product block to the end of its div wrapper.
# Since it's the last major block in the file (before the final closing divs of the whole component),
# we need to be careful. The entire block is wrapped in {selectedProduct && ( <div> ... </div> )}.
# It might be easier to just use string replace for the start tag and not move it, BUT change the layout.
# If we don't move it, how do we prevent it from covering the title bar?
# The wrapper of the whole component is `uiLab2MainStageClass`.
# Wait, `productContentCanvasClass` in Products has `desktopPanelRowClass`, which is `flex-1 min-h-0 flex px-4 pt-0 bambook-main-panel-bottom-inset relative`.
# If it's relative, placing the `absolute` block INSIDE it automatically bounds it below the TitleBar!
# So yes, moving it is the right approach.

# Let's extract the block.
# We find the matching brace for `{selectedProduct && (`
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

brace_start = content.find('{', selected_block_start_idx)
block_end = find_matching_brace(content, brace_start)

selected_block = content[selected_block_start_idx:block_end]

# Modify the selected block's starting line:
# From `{selectedProduct && (` to `{navLevel === 'detail' && selectedProduct && (`
# From `absolute inset-x-0 top-0 bottom-0 z-[40] ...` to `absolute inset-x-0 top-0 ${isMobile ? 'bottom-0' : BAMBOOK_OS.layout.desktopMainPanelBottomEdgeClass} z-[40] min-h-0 flex overflow-visible`
new_block = selected_block.replace('{selectedProduct && (', "{navLevel === 'detail' && selectedProduct && (")
new_block = new_block.replace('absolute inset-x-0 top-0 bottom-0 z-[40]', "absolute inset-x-0 top-0 ${isMobile ? 'bottom-0' : BAMBOOK_OS.layout.desktopMainPanelBottomEdgeClass} z-[20]")

# We need to insert new_block right before `canvas_end_idx`.
# And remove `selected_block` from its original position.

new_content = content[:selected_block_start_idx] + content[block_end:]
# Now find canvas_end_idx in new_content
mobile_sheet_idx_new = new_content.find('{/* Mobile Options Sheet */}')
canvas_end_idx_new = new_content.rfind('</div>', 0, mobile_sheet_idx_new)

final_content = new_content[:canvas_end_idx_new] + '\n        ' + new_block + '\n      ' + new_content[canvas_end_idx_new:]

with open(file_path, 'w') as f:
    f.write(final_content)

print("Done")
