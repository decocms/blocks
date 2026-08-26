import { describe, expect, it } from "vitest";
import { useScript } from "./useScript";

// useScript serializes call arguments into an executable inline <script>. A
// string arg containing `</script>` must not break out of the tag.
describe("useScript — argument serialization", () => {
  it("does not let a string argument break out of the script tag", () => {
    function greet(_name: string) {}
    const out = useScript(greet, "</script><script>alert(document.domain)</script>");
    expect(out).not.toContain("</script>");
  });
});
