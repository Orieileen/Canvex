/**
 * appState patch that makes `id` the canvas's **sole** selection.
 *
 * 为什么不只写 `selectedElementIds`: Excalidraw 的 renderInteractiveScene 会给
 * `selectedGroupIds` / `editingGroupId` 里**残留的每个 id** 单独画一圈虚线选框, 它
 * 只看这两个字段, 不核对 `selectedElementIds`。所以只换元素选择、不清组选择的话,
 * 上一次选中的那个组的虚线框会一直留在画布上 —— 用户看到"选了一个东西, 旁边还框着
 * 另一堆"。`updateScene` 是裸 setState, 不做这层归一化, 得调用方自己带上。
 */
export function soleSelectionAppState(id: string) {
  return {
    selectedElementIds: { [id]: true as const },
    selectedGroupIds: {} as Record<string, boolean>,
    editingGroupId: null,
  };
}
