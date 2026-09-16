import { describe, expect, it } from "bun:test";

import {
  DEPLOY_GRACE_MS,
  assessPipeline,
  pipelineLine,
  pipelineNotice,
  renderPipelineAlert,
  renderPipelineRecovered,
  type PipelineFacts,
} from "./pipeline-health";

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const facts = (over: Partial<PipelineFacts> = {}): PipelineFacts => ({
  deployedSha: "aaaaaaa",
  headSha: "aaaaaaa",
  headAt: NOW - 60_000,
  ci: "success",
  ...over,
});

describe("assessPipeline", () => {
  it("збірка дорівнює верхівці — усе гаразд", () => {
    expect(assessPipeline(facts(), NOW).level).toBe("ok");
  });

  it("червона перевірка — це поломка коду, і вона головніша за відставання", () => {
    /*
     * Червона перевірка пояснює відставання повністю. Назвати обидва стани
     * означало б дати дві різні інструкції на одну причину.
     */
    const a = assessPipeline(facts({ headSha: "bbbbbbb", ci: "failure" }), NOW);
    expect(a.level).toBe("ci-broken");
  });

  it("свіже відставання — ще не поломка: деплой триває хвилини", () => {
    const a = assessPipeline(facts({ headSha: "bbbbbbb", headAt: NOW - 60_000 }), NOW);
    expect(a.level).toBe("ok");
  });

  it("відставання, яке пережило запас часу, — зупинка конвеєра", () => {
    const a = assessPipeline(
      facts({ headSha: "bbbbbbb", headAt: NOW - DEPLOY_GRACE_MS - 1000 }),
      NOW,
    );
    expect(a.level).toBe("deploy-stuck");
    expect(a.behindMs).toBeGreaterThan(DEPLOY_GRACE_MS);
  });

  it("очікувана перевірка не вважається поломкою", () => {
    // «Ще йде» — не «впала». Інакше кожен пуш піднімав би тривогу.
    const a = assessPipeline(
      facts({ headSha: "bbbbbbb", ci: "pending", headAt: NOW - 60_000 }),
      NOW,
    );
    expect(a.level).toBe("ok");
  });

  it("без свого коміту судити нема з чим", () => {
    expect(assessPipeline(facts({ deployedSha: null }), NOW).level).toBe("unknown");
  });

  it("без верхівки гілки теж — це не «усе гаразд»", () => {
    /*
     * Саме таке «гаразд», видане наосліп, і коштувало доби: система мовчала,
     * бо їй не було чого сказати, а виглядало це як справність.
     */
    expect(assessPipeline(facts({ headSha: null }), NOW).level).toBe("unknown");
  });

  it("відставання без відмітки часу — невідомо, а не поломка", () => {
    const a = assessPipeline(facts({ headSha: "bbbbbbb", headAt: null }), NOW);
    expect(a.level).toBe("unknown");
  });
});

describe("pipelineNotice", () => {
  it("перехід у поломку — кажемо", () => {
    expect(pipelineNotice("ci-broken", null)).toBe("alert");
    expect(pipelineNotice("deploy-stuck", "ok")).toBe("alert");
  });

  it("той самий стан удруге — мовчимо", () => {
    // Повтор нічого не додає, а привчає гортати повідомлення.
    expect(pipelineNotice("ci-broken", "ci-broken")).toBeNull();
  });

  it("зміна різновиду поломки — кажемо: дії різні", () => {
    expect(pipelineNotice("deploy-stuck", "ci-broken")).toBe("alert");
  });

  it("одужання після поломки — кажемо", () => {
    expect(pipelineNotice("ok", "ci-broken")).toBe("recovered");
  });

  it("«гаразд» після «гаразд» — не привід писати", () => {
    expect(pipelineNotice("ok", "ok")).toBeNull();
    expect(pipelineNotice("ok", null)).toBeNull();
  });

  it("«невідомо» не будить нікого", () => {
    // Це майже завжди мережа; будити на кожен збій — знецінити всі повідомлення.
    expect(pipelineNotice("unknown", "ok")).toBeNull();
    expect(pipelineNotice("unknown", "ci-broken")).toBeNull();
  });
});

describe("тексти", () => {
  it("рядок у /stats мовчить, коли все гаразд", () => {
    expect(pipelineLine(assessPipeline(facts(), NOW), facts())).toBeNull();
  });

  it("рядок у /stats називає обидва коміти", () => {
    const f = facts({ headSha: "bbbbbbb", ci: "failure" });
    const t = pipelineLine(assessPipeline(f, NOW), f)!;
    expect(t).toContain("aaaaaaa");
    expect(t).toContain("bbbbbbb");
  });

  it("червона перевірка веде лагодити КОД", () => {
    const f = facts({ headSha: "bbbbbbb", ci: "failure" });
    const t = renderPipelineAlert(assessPipeline(f, NOW), f);
    expect(t).toContain("Лагодити треба код");
    expect(t).toContain("лок не збігається");
  });

  it("застряглий деплой веде лагодити РОЗГОРТАННЯ — це протилежна дія", () => {
    const f = facts({ headSha: "bbbbbbb", headAt: NOW - DEPLOY_GRACE_MS - 1000 });
    const t = renderPipelineAlert(assessPipeline(f, NOW), f);
    expect(t).toContain("Лагодити треба розгортання");
    expect(t).not.toContain("Лагодити треба код");
  });

  it("одужання називає коміт, на якому зійшлись", () => {
    expect(renderPipelineRecovered(facts())).toContain("aaaaaaa");
  });

  it("час відставання читається людиною", () => {
    const f = facts({ headSha: "bbbbbbb", headAt: NOW - 26 * 60 * 60 * 1000 });
    expect(renderPipelineAlert(assessPipeline(f, NOW), f)).toContain("1 д 2 год");
  });
});
