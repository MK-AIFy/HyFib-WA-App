import test from "node:test";
import assert from "node:assert/strict";
import { buildWaLink, renderWidgetScript } from "../dist/click-to-chat.js";

test("buildWaLink strips the plus and formatting, keeps the text bounded", () => {
  const plain = buildWaLink({ phone: "+1 (555) 123-4567" });
  assert.equal(plain.ok, true);
  assert.equal(plain.value, "https://wa.me/15551234567");

  const withText = buildWaLink({ phone: "+15551234567", text: "  Hi there!  " });
  assert.equal(withText.value, "https://wa.me/15551234567?text=Hi+there%21");

  const long = buildWaLink({ phone: "+15551234567", text: "x".repeat(2000) });
  assert.equal(new URL(long.value).searchParams.get("text").length, 1024);
});

test("buildWaLink rejects non-E.164 input", () => {
  for (const phone of ["", "abc", "+0123", "123", "+1555123456789012345"]) {
    assert.equal(buildWaLink({ phone }).ok, false, `should reject "${phone}"`);
  }
});

test("widget script embeds values safely and honours position", () => {
  const script = renderWidgetScript({
    waLink: "https://wa.me/15551234567",
    position: "left",
    label: 'Chat "now" </script>'
  });
  assert.match(script, /left:24px/);
  assert.equal(script.includes("</script>"), false, "label cannot break out of script context");
  assert.match(script, /Chat \\"now\\"/);
  assert.match(script, /https:\/\/wa\.me\/15551234567/);

  const right = renderWidgetScript({ waLink: "https://wa.me/1", position: "right", label: "Chat" });
  assert.match(right, /right:24px/);
});
