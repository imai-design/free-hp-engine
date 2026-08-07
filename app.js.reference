(() => {
  "use strict";

  const form = document.querySelector("#site-form");
  if (!form) return;

  const preview = document.querySelector("#sample-site");
  const previewValues = {
    shopName: preview.querySelector('[data-preview="shopName"]'),
    businessType: preview.querySelector('[data-preview="businessType"]'),
    catchcopy: preview.querySelector('[data-preview="catchcopy"]'),
    description: preview.querySelector('[data-preview="description"]'),
    phone: preview.querySelector('[data-preview="phone"]'),
    address: preview.querySelector('[data-preview="address"]')
  };
  const typeBlocks = {
    "飲食店": preview.querySelector('[data-type-block="restaurant"]'),
    "美容・サロン": preview.querySelector('[data-type-block="beauty"]'),
    "その他": preview.querySelector('[data-type-block="other"]')
  };
  const moodColors = {
    "あたたかい": "var(--preview-warm)",
    "落ち着いた": "var(--preview-calm)",
    "さわやか": "var(--preview-fresh)"
  };

  const getValue = (name) => {
    const field = form.elements[name];
    if (!field) return "";
    if (field instanceof RadioNodeList) return field.value;
    return field.value.trim();
  };

  const displayValue = (value, fallback) => value || fallback;

  const updatePreview = () => {
    const name = getValue("shopName");
    const type = getValue("businessType") || "飲食店";
    const catchcopy = getValue("catchcopy");
    const description = getValue("description");
    const mood = getValue("mood") || "あたたかい";
    const phone = getValue("phone");
    const address = getValue("address");

    previewValues.shopName.textContent = displayValue(name, "あなたのお店");
    previewValues.businessType.textContent = type;
    previewValues.catchcopy.textContent = displayValue(catchcopy, "ここに、あなたの物語を。");
    previewValues.description.textContent = displayValue(description, "あなたのお店の紹介文がここに入ります。");
    previewValues.phone.textContent = displayValue(phone, "電話番号はここに表示されます");
    previewValues.address.textContent = displayValue(address, "住所・営業時間はここに表示されます");
    preview.style.setProperty("--preview-accent", moodColors[mood] || moodColors["あたたかい"]);

    Object.entries(typeBlocks).forEach(([label, block]) => {
      block.hidden = label !== type;
    });
  };

  const buildApplicationText = () => {
    const values = {
      name: displayValue(getValue("shopName"), "未入力"),
      type: getValue("businessType") || "未選択",
      catchcopy: displayValue(getValue("catchcopy"), "未入力"),
      description: displayValue(getValue("description"), "未入力"),
      mood: getValue("mood") || "未選択",
      phone: displayValue(getValue("phone"), "未入力"),
      address: displayValue(getValue("address"), "未入力"),
      badgeChoice: getValue("badgeChoice") || "つけたまま（無料）"
    };
    return [
      "無料ホームページ申込",
      "",
      `お店・活動の名前：${values.name}`,
      `業種：${values.type}`,
      `キャッチコピー：${values.catchcopy}`,
      `紹介文：${values.description}`,
      `色の雰囲気：${values.mood}`,
      `電話番号：${values.phone}`,
      `住所・営業時間：${values.address}`,
      `表示について：${values.badgeChoice}`
    ].join("\n");
  };

  const modal = document.querySelector("#application-modal");
  const applyButton = document.querySelector("#apply-button");
  const closeButton = document.querySelector("#modal-close");
  const applicationText = document.querySelector("#application-text");
  const mailLink = document.querySelector("#mail-link");
  const copyButton = document.querySelector("#copy-button");
  const copyStatus = document.querySelector("#copy-status");
  let lastFocusedElement = null;

  const updateApplication = () => {
    const text = buildApplicationText();
    applicationText.value = text;
    mailLink.href = `mailto:kaeru3160@gmail.com?subject=${encodeURIComponent("無料ホームページ申込")}&body=${encodeURIComponent(text)}`;
  };

  const openModal = () => {
    updateApplication();
    lastFocusedElement = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    closeButton.focus();
  };

  const closeModal = () => {
    modal.hidden = true;
    document.body.style.overflow = "";
    copyStatus.textContent = "";
    if (lastFocusedElement) lastFocusedElement.focus();
  };

  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
  applyButton.addEventListener("click", openModal);
  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeModal();
  });

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(applicationText.value);
      copyStatus.textContent = "申込内容をコピーしました。";
    } catch (error) {
      applicationText.focus();
      applicationText.select();
      copyStatus.textContent = "内容を選択しました。コピーしてください。";
    }
  });

  updatePreview();
})();
