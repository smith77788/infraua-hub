import { afterEach, describe, expect, it } from "bun:test";

import { baseReport } from "./health";

describe("baseReport — версія процесу", () => {
  const saved = process.env["RAILWAY_GIT_COMMIT_SHA"];
  afterEach(() => {
    if (saved === undefined) delete process.env["RAILWAY_GIT_COMMIT_SHA"];
    else process.env["RAILWAY_GIT_COMMIT_SHA"] = saved;
  });

  it("на Railway — короткий коміт, з якого зібрано процес", () => {
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "9396ece0123456789abcdef";
    expect(baseReport().commit).toBe("9396ece");
  });

  it("поза Railway поля немає — не вигадуємо версію", () => {
    delete process.env["RAILWAY_GIT_COMMIT_SHA"];
    expect("commit" in baseReport()).toBe(false);
  });
});
