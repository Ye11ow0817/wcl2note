import { expect, it } from "vitest";
import { noteFilename, windowsText } from "../../../src/main/export";
it("Windows 导出使用合法 TXT 文件名，并处理设备保留名称", () => {
  expect(noteFilename("首领:第二阶段?.txt")).toBe("首领_第二阶段_.txt");
  expect(noteFilename("CON.txt")).toBe("_CON.txt");
  expect(noteFilename("团队笔记")).toBe("团队笔记.txt");
});
it("导出与剪贴板统一 Windows 换行，不重复转换 CRLF", () => {
  expect(windowsText("中文\n{time:00:01} 技能\r\n末行")).toBe(
    "中文\r\n{time:00:01} 技能\r\n末行",
  );
});
