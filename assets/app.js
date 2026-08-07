(() => {
  "use strict";

  const API_URL = "https://free-hp-engine.ryoseiworld.workers.dev/api/generate";
  const EXPECTED_WORKER_ORIGIN = "https://free-hp-engine.ryoseiworld.workers.dev";

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

  const applyButton = document.querySelector("#apply-button");
  const generationResult = document.querySelector("#generation-result");
  const generationLoading = document.querySelector("#generation-loading");
  const generationSuccess = document.querySelector("#generation-success");
  const generationError = document.querySelector("#generation-error");
  const generationStatus = document.querySelector("#generation-status");
  const errorMessage = document.querySelector("#generation-error-message");
  const generatedLink = document.querySelector("#generated-link");
  const generatedPreview = document.querySelector("#generated-preview");
  const copyGeneratedLinkButton = document.querySelector("#copy-generated-link");
  const generatedCopyStatus = document.querySelector("#generated-copy-status");
  const manualContactLink = document.querySelector("#manual-contact-link");

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

  const buildSiteInput = () => ({
    storeName: getValue("shopName"),
    industry: getValue("businessType"),
    catchphrase: getValue("catchcopy"),
    description: getValue("description"),
    colorTheme: getValue("mood"),
    phone: getValue("phone"),
    address: getValue("address")
  });

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
      "無料ホームページ申込（自動生成がうまくいかない場合）",
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

  const updateManualContactLink = () => {
    manualContactLink.href = `mailto:kaeru3160@gmail.com?subject=${encodeURIComponent("無料ホームページの相談")}&body=${encodeURIComponent(buildApplicationText())}`;
  };

  const setGenerationState = (state) => {
    generationResult.hidden = false;
    generationLoading.hidden = state !== "loading";
    generationSuccess.hidden = state !== "success";
    generationError.hidden = state !== "error";
    generationResult.dataset.state = state;
  };

  const validationMessageFor = (detail) => {
    const messages = [
      [/^storeName is required$/u, "お店・活動の名前を入力してください。"],
      [/^storeName must be 1-40 characters$/u, "お店・活動の名前は1〜40文字で入力してください。"],
      [/^storeName contains invalid control characters$/u, "お店・活動の名前に使用できない文字が含まれています。"],
      [/^industry is invalid$/u, "業種の選択を確認してください。"],
      [/^catchphrase is required$/u, "キャッチコピーを入力してください。"],
      [/^catchphrase must be 1-60 characters$/u, "キャッチコピーは1〜60文字で入力してください。"],
      [/^description is required$/u, "紹介文を入力してください。"],
      [/^description must be 1-400 characters$/u, "紹介文は1〜400文字で入力してください。"],
      [/^colorTheme is invalid$/u, "色の雰囲気の選択を確認してください。"],
      [/^phone must be at most 40 characters$/u, "電話番号は40文字以内で入力してください。"],
      [/^address must be at most 200 characters$/u, "住所・営業時間は200文字以内で入力してください。"],
      [/^request body must be valid JSON$/u, "入力内容を読み取れませんでした。もう一度お試しください。"]
    ];
    const known = messages.find(([pattern]) => pattern.test(detail));
    return known ? known[1] : "入力内容を確認してください。必須項目を入力して、もう一度お試しください。";
  };

  const errorMessageFor = (status, serverMessage) => {
    const detail = typeof serverMessage === "string" ? serverMessage : "";
    switch (status) {
      case 400:
        return validationMessageFor(detail);
      case 422:
        return detail || "生成内容の確認に失敗しました。もう一度お試しください。";
      case 429:
        return detail || "生成回数の上限に達しました。時間をおいて、もう一度お試しください。";
      case 502:
        return detail || "生成サービスとの通信に失敗しました。少し時間をおいて、もう一度お試しください。";
      case 503:
        return detail || "生成サービスの準備中です。少し時間をおいて、もう一度お試しください。";
      default:
        return detail || "ホームページを生成できませんでした。もう一度お試しください。";
    }
  };

  const showError = (message) => {
    errorMessage.textContent = message;
    generationStatus.textContent = "生成できませんでした";
    setGenerationState("error");
  };

  const showSuccess = (url) => {
    generatedLink.href = url;
    generatedLink.textContent = url;
    generatedPreview.src = url;
    generatedPreview.hidden = false;
    generationStatus.textContent = "ホームページができました";
    generatedCopyStatus.textContent = "";
    setGenerationState("success");
  };

  const submitGeneration = async () => {
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    applyButton.disabled = true;
    applyButton.setAttribute("aria-busy", "true");
    applyButton.dataset.defaultLabel = applyButton.textContent;
    applyButton.textContent = "ホームページを作っています…";
    generationStatus.textContent = "ホームページを生成しています…";
    setGenerationState("loading");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSiteInput())
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }

      if (!response.ok) {
        showError(errorMessageFor(response.status, result.error));
        return;
      }

      let generatedUrl;
      try {
        generatedUrl = new URL(result.url);
      } catch {
        showError("生成結果の公開URLを確認できませんでした。メールでご相談ください。");
        return;
      }
      if (generatedUrl.origin !== EXPECTED_WORKER_ORIGIN || generatedUrl.hostname !== "free-hp-engine.ryoseiworld.workers.dev" || !/^\/s\/[a-z0-9-]{4,80}$/u.test(generatedUrl.pathname)) {
        showError("安全を確認できない公開URLが返されたため、表示を止めました。メールでご相談ください。");
        return;
      }
      showSuccess(generatedUrl.href);
    } catch {
      showError("通信に失敗しました。少し時間をおいて、もう一度お試しください。");
    } finally {
      applyButton.disabled = false;
      applyButton.removeAttribute("aria-busy");
      applyButton.textContent = applyButton.dataset.defaultLabel || "このホームページを、無料でもらう →";
    }
  };

  const copyGeneratedLink = async () => {
    const url = generatedLink.href;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      generatedCopyStatus.textContent = "リンクをコピーしました。";
    } catch {
      generatedCopyStatus.textContent = "リンクを選択しました。コピーしてください。";
      generatedLink.focus();
    }
  };

  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
  form.addEventListener("input", updateManualContactLink);
  form.addEventListener("change", updateManualContactLink);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitGeneration();
  });
  copyGeneratedLinkButton.addEventListener("click", copyGeneratedLink);

  updatePreview();
  updateManualContactLink();
})();
