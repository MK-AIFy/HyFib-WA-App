import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateBody,
  buildTextBody,
  buildMediaBody,
  buildInteractiveBody,
  buildMarkReadBody,
  buildMediaUploadForm,
  mapMetaTemplateStatus,
  extractTemplateBody,
  buildProductMessage,
  buildCatalogMessage,
  buildFlowMessage
} from "../dist/graph-messages.js";

test("template body falls back to positional params", () => {
  const body = buildTemplateBody({
    to: "15551230000",
    templateName: "welcome",
    templateLanguage: "en_US",
    parameters: ["Alice", "ORDER-1"]
  });
  assert.equal(body.type, "template");
  assert.equal(body.template.name, "welcome");
  assert.equal(body.template.language.code, "en_US");
  assert.equal(body.template.components[0].type, "body");
  assert.deepEqual(body.template.components[0].parameters, [
    { type: "text", text: "Alice" },
    { type: "text", text: "ORDER-1" }
  ]);
});

test("template body omits components when no params", () => {
  const body = buildTemplateBody({ to: "1", templateName: "t", templateLanguage: "en", parameters: [] });
  assert.equal("components" in body.template, false);
});

test("template body prefers structured components", () => {
  const components = [
    { type: "header", parameters: [{ type: "image", image: { link: "https://x/y.png" } }] },
    { type: "button", sub_type: "url", index: 0, parameters: [{ type: "payload", payload: "TRACK-1" }] }
  ];
  const body = buildTemplateBody({
    to: "1",
    templateName: "t",
    templateLanguage: "en",
    parameters: ["ignored"],
    components
  });
  assert.deepEqual(body.template.components, components);
});

test("text body sets preview_url", () => {
  const body = buildTextBody({ to: "1", text: "hello", previewUrl: true });
  assert.equal(body.type, "text");
  assert.equal(body.text.body, "hello");
  assert.equal(body.text.preview_url, true);
});

test("media body uses id over link and attaches filename only for documents", () => {
  const doc = buildMediaBody({ to: "1", mediaType: "document", mediaId: "MID", caption: "c", filename: "f.pdf" });
  assert.equal(doc.type, "document");
  assert.deepEqual(doc.document, { id: "MID", caption: "c", filename: "f.pdf" });

  const img = buildMediaBody({ to: "1", mediaType: "image", link: "https://x/y.png", caption: "c", filename: "n.png" });
  assert.deepEqual(img.image, { link: "https://x/y.png", caption: "c" });

  const audio = buildMediaBody({ to: "1", mediaType: "audio", link: "https://x/a.ogg", caption: "ignored" });
  assert.deepEqual(audio.audio, { link: "https://x/a.ogg" });
});

test("interactive button body shapes reply buttons", () => {
  const body = buildInteractiveBody({
    to: "1",
    interactiveType: "button",
    bodyText: "Pick one",
    buttons: [{ id: "yes", title: "Yes" }]
  });
  assert.equal(body.interactive.type, "button");
  assert.deepEqual(body.interactive.action.buttons, [{ type: "reply", reply: { id: "yes", title: "Yes" } }]);
});

test("interactive list body shapes sections", () => {
  const body = buildInteractiveBody({
    to: "1",
    interactiveType: "list",
    bodyText: "Menu",
    buttonLabel: "Open",
    sections: [{ title: "Drinks", rows: [{ id: "tea", title: "Tea", description: "hot" }] }]
  });
  assert.equal(body.interactive.action.button, "Open");
  assert.equal(body.interactive.action.sections[0].rows[0].description, "hot");
});

test("mark-read body", () => {
  assert.deepEqual(buildMarkReadBody("wamid.1"), {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid.1"
  });
});

test("maps meta template statuses", () => {
  assert.equal(mapMetaTemplateStatus("APPROVED"), "approved");
  assert.equal(mapMetaTemplateStatus("REJECTED"), "rejected");
  assert.equal(mapMetaTemplateStatus("DISABLED"), "rejected");
  assert.equal(mapMetaTemplateStatus("PAUSED"), "paused");
  assert.equal(mapMetaTemplateStatus("IN_APPEAL"), "pending");
  assert.equal(mapMetaTemplateStatus(undefined), "pending");
});

test("media upload form carries the product, bytes, type and filename", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80]);
  const form = buildMediaUploadForm({ buffer: bytes, mimeType: "image/jpeg", filename: "photo.jpg" });

  assert.equal(form.get("messaging_product"), "whatsapp");
  const file = form.get("file");
  assert.equal(file.name, "photo.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(file.size, bytes.length);
  const roundTripped = Buffer.from(await file.arrayBuffer());
  assert.equal(Buffer.compare(roundTripped, bytes), 0);
});

test("media upload form defaults the filename", () => {
  const form = buildMediaUploadForm({ buffer: Buffer.from("abc"), mimeType: "application/pdf" });
  assert.equal(form.get("file").name, "upload");
});

test("extracts body text from meta components", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hi" },
    { type: "BODY", text: "Your order {{1}} shipped" }
  ];
  assert.equal(extractTemplateBody(components), "Your order {{1}} shipped");
  assert.equal(extractTemplateBody(undefined), "");
});

test("buildProductMessage shapes a single-product interactive body", () => {
  const body = buildProductMessage({
    to: "+15551230000",
    catalogId: "cat-1",
    productRetailerId: "sku-42",
    bodyText: "Check this out"
  });
  assert.equal(body.messaging_product, "whatsapp");
  assert.equal(body.type, "interactive");
  assert.equal(body.interactive.type, "product");
  assert.equal(body.interactive.action.catalog_id, "cat-1");
  assert.equal(body.interactive.action.product_retailer_id, "sku-42");
  assert.equal(body.interactive.body.text, "Check this out");
});

test("buildProductMessage defaults bodyText to a space", () => {
  const body = buildProductMessage({ to: "1", catalogId: "c", productRetailerId: "p" });
  assert.equal(body.interactive.body.text, " ");
});

test("buildCatalogMessage shapes a multi-product list", () => {
  const body = buildCatalogMessage({
    to: "+15551230000",
    catalogId: "cat-1",
    sections: [{ title: "Shoes", productItems: [{ productRetailerId: "shoe-1" }, { productRetailerId: "shoe-2" }] }],
    headerText: "Our Catalogue",
    footerText: "Tap to order"
  });
  assert.equal(body.type, "interactive");
  assert.equal(body.interactive.type, "product_list");
  assert.equal(body.interactive.header.text, "Our Catalogue");
  assert.equal(body.interactive.footer.text, "Tap to order");
  assert.equal(body.interactive.action.sections[0].title, "Shoes");
  assert.equal(body.interactive.action.sections[0].product_items[0].product_retailer_id, "shoe-1");
});

test("buildCatalogMessage omits header/footer when not provided", () => {
  const body = buildCatalogMessage({ to: "1", catalogId: "c", sections: [] });
  assert.equal("header" in body.interactive, false);
  assert.equal("footer" in body.interactive, false);
});

test("buildFlowMessage shapes a flow interactive body", () => {
  const body = buildFlowMessage({
    to: "+15551230000",
    flowId: "flow-99",
    flowToken: "tok-abc",
    bodyText: "Complete your profile",
    ctaButtonText: "Start",
    headerText: "Setup",
    footerText: "Powered by HyFib"
  });
  assert.equal(body.type, "interactive");
  assert.equal(body.interactive.type, "flow");
  assert.equal(body.interactive.action.parameters.flow_id, "flow-99");
  assert.equal(body.interactive.action.parameters.flow_token, "tok-abc");
  assert.equal(body.interactive.action.parameters.flow_cta, "Start");
  assert.equal(body.interactive.header.text, "Setup");
  assert.equal(body.interactive.footer.text, "Powered by HyFib");
  assert.equal("mode" in body.interactive.action.parameters, false);
});

test("buildFlowMessage includes draft mode when specified", () => {
  const body = buildFlowMessage({
    to: "1",
    flowId: "f",
    flowToken: "t",
    bodyText: "body",
    ctaButtonText: "Go",
    mode: "draft"
  });
  assert.equal(body.interactive.action.parameters.mode, "draft");
});
