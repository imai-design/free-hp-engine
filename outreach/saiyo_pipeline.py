#!/usr/bin/env python3
"""採用装置プランの候補抽出・見本生成・クラウド投入パイプライン。"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


OUTREACH_DIR = Path(__file__).resolve().parent
LEADS_PATH = OUTREACH_DIR / "saiyo_leads.json"
BATCH_KEY_PATH = Path("~/.freehp-batch-key").expanduser()
ADMIN_KEY_PATH = Path("~/.freehp-cloud-admin-key").expanduser()

SAMPLE_API = "https://free-hp-engine.ryoseiworld.workers.dev/api/sample"
UNPUBLISH_API = "https://free-hp-engine.ryoseiworld.workers.dev/api/sample/unpublish"
CLOUD_LEADS_API = "https://freehp-cloud.ryoseiworld.workers.dev/admin/b2b/leads"
USER_AGENT = "freehp-saiyo-pipeline/1.0 (+https://freehp.jp)"
PUSH_NOTE = "2026-08-20 採用装置 候補（scout収集・メール根拠URL照合済み）"
FORBIDDEN_SAMPLE_WORDS = ("お店", "ご来店", "無料")
MAX_DOWNLOAD_BYTES = 2_000_000


class PipelineError(RuntimeError):
    """利用者に秘密情報を含めず表示できるパイプラインエラー。"""


def _path(value: str | Path | None) -> Path:
    return LEADS_PATH if value is None else Path(value).expanduser()


def _normalize_text(value: str) -> str:
    value = html.unescape(value).replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", " ", value).strip()


def _plain_markdown(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = value.replace(r"\|", "|")
    value = re.sub(r"[*_~`]+", "", value)
    return _normalize_text(value)


def _split_markdown_row(line: str) -> list[str]:
    """エスケープされた縦棒を壊さずMarkdown表の1行を分割する。"""

    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|") and not stripped.endswith(r"\|"):
        stripped = stripped[:-1]

    cells: list[str] = []
    current: list[str] = []
    escaped = False
    in_code = False
    for character in stripped:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\":
            escaped = True
            current.append(character)
        elif character == "`":
            in_code = not in_code
            current.append(character)
        elif character == "|" and not in_code:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(character)
    if escaped:
        current.append("\\")
    cells.append("".join(current).strip())
    return cells


def _is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def _extract_email(value: str) -> str:
    decoded = html.unescape(value).replace("mailto:", "")
    match = re.search(r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}", decoded, re.IGNORECASE)
    return match.group(0).lower() if match else ""


def _extract_url(value: str) -> str:
    decoded = html.unescape(value).strip()
    markdown_link = re.search(r"\]\((https?://[^\s)]+)", decoded, re.IGNORECASE)
    raw_link = re.search(r"https?://[^\s<>|]+", decoded, re.IGNORECASE)
    candidate = (markdown_link or raw_link)
    if not candidate:
        return ""
    url = candidate.group(1) if markdown_link else candidate.group(0)
    url = url.rstrip(".,;:、。）」〉》]")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return ""
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _clip_with_ellipsis(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    if limit <= 1:
        return "…"[:limit]
    return value[: limit - 1].rstrip("、, /／") + "…"


def summarize_signal(job_signal: str, hp_problem: str) -> str:
    job = _plain_markdown(job_signal)
    hp = _plain_markdown(hp_problem)
    if job and hp:
        capacity = 80 - len("求人:／HP:")
        job_quota = min(len(job), capacity // 2)
        hp_quota = min(len(hp), capacity - job_quota)
        job_quota = min(len(job), capacity - hp_quota)
        return f"求人:{_clip_with_ellipsis(job, job_quota)}／HP:{_clip_with_ellipsis(hp, hp_quota)}"
    if job:
        return f"求人:{_clip_with_ellipsis(job, 80 - len('求人:'))}"
    if hp:
        return f"HP:{_clip_with_ellipsis(hp, 80 - len('HP:'))}"
    return ""


def extract_municipality(address: str) -> str:
    location = _plain_markdown(address)
    location = re.sub(r"〒?\s*\d{3}-?\d{4}", "", location)
    prefecture = re.search(r"北海道|東京都|(?:京都|大阪)府|[一-龥々ヶヵ]{2,3}県", location)
    if prefecture:
        location = location[prefecture.end() :]
    match = re.search(r"([一-龥々ヶヵぁ-んァ-ヶー]{1,12}?(?:市|区|町|村))", location)
    if match:
        return match.group(1)
    fallback = re.split(r"[\s,，0-9０-９-]", location.strip(), maxsplit=1)[0]
    return fallback[:12] or "地域"


def classify_industry(industry: str) -> tuple[str, str]:
    value = _plain_markdown(industry)
    rules = (
        (r"介護|福祉|老人|デイサービス|訪問看護", "介護事業所", "医療・クリニック"),
        (r"情報サービス|システム|ソフトウェア|IT|ＩＴ|ウェブ|Web", "システム開発会社", "その他"),
        (r"運輸|運送|物流|貨物|トラック", "運送会社", "不動産・建設"),
        (r"建設|建築|工務店|土木|設備工事|電気工事|塗装|内装|解体", "建設会社", "不動産・建設"),
        (r"病院|診療所|クリニック|医療", "医療機関", "医療・クリニック"),
        (r"製造", "製造会社", "その他"),
        (r"警備", "警備会社", "その他"),
        (r"清掃", "清掃会社", "その他"),
        (r"人材|職業紹介", "人材会社", "その他"),
        (r"卸売|小売|販売", "販売会社", "その他"),
    )
    for pattern, label, engine_industry in rules:
        if re.search(pattern, value, re.IGNORECASE):
            return label, engine_industry
    base = re.split(r"[（(・/／]", value, maxsplit=1)[0]
    base = re.sub(r"(?:産業|事業|業)$", "", base).strip()
    return ((f"{base}会社" if base else "事業会社"), "その他")


def _markdown_rows(markdown: str) -> list[dict[str, str]]:
    lines = markdown.splitlines()
    header_index = -1
    headers: list[str] = []
    for index, line in enumerate(lines):
        cells = [_plain_markdown(cell) for cell in _split_markdown_row(line)]
        if "名称" in cells and "代表メール" in cells:
            header_index = index
            headers = cells
            break
    if header_index < 0:
        raise PipelineError("必要な列（名称・代表メール）を含むMarkdown表が見つかりません")

    rows: list[dict[str, str]] = []
    started = False
    for line in lines[header_index + 1 :]:
        if not line.strip():
            if started:
                break
            continue
        cells = _split_markdown_row(line)
        if _is_separator_row(cells):
            continue
        if len(cells) < 2:
            if started:
                break
            continue
        started = True
        cells.extend([""] * (len(headers) - len(cells)))
        rows.append(dict(zip(headers, cells[: len(headers)])))
    return rows


def parse_markdown(md_path: str | Path, leads_path: str | Path | None = None) -> list[dict[str, Any]]:
    source = Path(md_path).expanduser()
    try:
        markdown = source.read_text(encoding="utf-8")
    except OSError as error:
        raise PipelineError(f"入力Markdownを読めません: {type(error).__name__}") from error

    leads: list[dict[str, Any]] = []
    for row in _markdown_rows(markdown):
        name = _plain_markdown(row.get("名称", ""))
        if not name:
            continue
        industry_word, engine_industry = classify_industry(row.get("業種", ""))
        municipality = extract_municipality(row.get("所在地", ""))
        leads.append(
            {
                "name": name,
                "email": _extract_email(row.get("代表メール", "")),
                "url": _extract_url(row.get("公式URL", "")),
                "evidence_url": _extract_url(row.get("メールの根拠URL", "")),
                "industry": "採用",
                "signal": summarize_signal(row.get("求人シグナル", ""), row.get("HPの困りごと", "")),
                "storeName": name,
                "catchphrase": f"{municipality}の{industry_word}",
                "description": "",
                "skeleton": "看板",
                "colorTheme": "落ち着いた",
                "engineIndustry": engine_industry,
                "note": "",
            }
        )

    save_leads(leads, leads_path)
    print(f"解析・保存: {len(leads)}件")
    return leads


def load_leads(leads_path: str | Path | None = None) -> list[dict[str, Any]]:
    path = _path(leads_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise PipelineError(f"リードJSONを読めません: {type(error).__name__}") from error
    except json.JSONDecodeError as error:
        raise PipelineError("リードJSONが不正です") from error
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise PipelineError("リードJSONはオブジェクトの配列である必要があります")
    return value


def save_leads(leads: list[dict[str, Any]], leads_path: str | Path | None = None) -> None:
    path = _path(leads_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(leads, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


class _PageTextParser(HTMLParser):
    IGNORED = {"script", "style", "noscript", "svg", "template", "nav", "header", "footer", "form"}
    BLOCKS = {"address", "article", "aside", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "main", "p", "section"}
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.in_body = False
        self.ignore_depth = 0
        self.title_parts: list[str] = []
        self.meta_descriptions: list[str] = []
        self.body_parts: list[str] = []
        self.visible_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = {key.lower(): (value or "") for key, value in attrs}
        if tag == "meta":
            kind = (attributes.get("name") or attributes.get("property") or "").lower()
            if kind in {"description", "og:description"} and attributes.get("content"):
                self.meta_descriptions.append(attributes["content"])
        if self.ignore_depth:
            if tag not in self.VOID:
                self.ignore_depth += 1
            return
        if tag in self.IGNORED:
            self.ignore_depth = 1
            return
        if tag == "title":
            self.in_title = True
        elif tag == "body":
            self.in_body = True
        if self.in_body and tag in self.BLOCKS:
            self.body_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.ignore_depth:
            self.ignore_depth -= 1
            return
        if tag == "title":
            self.in_title = False
        if self.in_body and tag in self.BLOCKS:
            self.body_parts.append("\n")
        if tag == "body":
            self.in_body = False

    def handle_data(self, data: str) -> None:
        if self.ignore_depth:
            return
        if self.in_title:
            self.title_parts.append(data)
            return
        self.visible_parts.append(data)
        if self.in_body:
            self.body_parts.append(data)


def _sentence_units(value: str) -> list[str]:
    units: list[str] = []
    for line in value.splitlines():
        for unit in re.split(r"[。！？!?]+", line):
            cleaned = _normalize_text(unit).strip(".,;:、，・｜|／/—–- ")
            if len(cleaned) >= 3:
                units.append(cleaned)
    return units


def _clip_fact(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    window = value[:limit]
    boundaries = [window.rfind(mark) for mark in ("、", "，", ",", "・", "｜", "|", " ")]
    boundary = max(boundaries)
    if boundary >= max(10, limit // 2):
        window = window[:boundary]
    return window.rstrip("、，,・｜| ")


def _split_long_fact(value: str) -> tuple[str, str] | None:
    if len(value) < 58:
        return None
    midpoint = len(value) // 2
    positions = [match.start() for match in re.finditer(r"[、，,・｜|：:\s]", value)]
    viable = [position for position in positions if 15 <= position <= len(value) - 15]
    split_at = min(viable, key=lambda position: abs(position - midpoint)) if viable else midpoint
    left = value[:split_at].rstrip("、，,・｜|：: ")
    right = value[split_at + (1 if split_at < len(value) and value[split_at] in "、，,・｜|：: " else 0) :].strip()
    return (left, right) if left and right else None


def build_description(page_html: str) -> tuple[str, str]:
    parser = _PageTextParser()
    try:
        parser.feed(page_html)
        parser.close()
    except Exception as error:  # HTMLParserは寛容だが、壊れた入力でもリード単位で止める。
        return "", f"HTML解析失敗({type(error).__name__})"

    title = _normalize_text(" ".join(parser.title_parts))
    meta_text = "\n".join(_normalize_text(item) for item in parser.meta_descriptions)
    body_source = "".join(parser.body_parts) if parser.body_parts else " ".join(parser.visible_parts)
    body_source = body_source[:8_000]

    candidates: list[str] = []
    seen: set[str] = set()
    for source in (title, meta_text, body_source):
        for unit in _sentence_units(source):
            signature = re.sub(r"[\W_]+", "", unit).lower()
            if not signature or signature in seen:
                continue
            seen.add(signature)
            candidates.append(unit)
    if not candidates:
        return "", "本文が薄い"

    first = _clip_fact(candidates[0], 68)
    remaining = candidates[1:]
    if not remaining:
        split = _split_long_fact(first)
        if not split:
            return "", "本文が薄い"
        first, second = split
    else:
        second_parts: list[str] = []
        for candidate in remaining:
            if candidate in first:
                continue
            current = "、".join(second_parts)
            separator_length = 1 if current else 0
            room = 138 - len(first) - len(current) - separator_length
            if room <= 0:
                break
            fragment = _clip_fact(candidate, room)
            if fragment:
                second_parts.append(fragment)
            if len(first) + len("、".join(second_parts)) + 2 >= 60:
                break
        second = "、".join(second_parts)
        if not second:
            split = _split_long_fact(first)
            if not split:
                return "", "本文が薄い"
            first, second = split

    description = f"{first}。{second}。"
    if not 60 <= len(description) <= 140:
        return "", "本文が薄い"
    return description, ""


def _response_charset(response: Any) -> str:
    headers = getattr(response, "headers", None)
    if headers is not None and hasattr(headers, "get_content_charset"):
        return headers.get_content_charset() or "utf-8"
    content_type = headers.get("content-type", "") if headers is not None and hasattr(headers, "get") else ""
    match = re.search(r"charset=([\w.-]+)", content_type, re.IGNORECASE)
    return match.group(1) if match else "utf-8"


def _read_response(response: Any) -> str:
    data = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(data) > MAX_DOWNLOAD_BYTES:
        data = data[:MAX_DOWNLOAD_BYTES]
    charset = _response_charset(response)
    try:
        return data.decode(charset)
    except (LookupError, UnicodeDecodeError):
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.decode("cp932", errors="replace")


def _request_text(request: urllib.request.Request, timeout: int) -> str:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return _read_response(response)


def _post_json(url: str, payload: Any, key_header: str, key: str, timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            key_header: key,
            "user-agent": USER_AGENT,
        },
    )
    text = _request_text(request, timeout)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise PipelineError("API応答がJSONではありません") from error
    if not isinstance(value, dict):
        raise PipelineError("API応答がJSONオブジェクトではありません")
    return value


def _failure_label(error: BaseException) -> str:
    if isinstance(error, urllib.error.HTTPError):
        return f"HTTP {error.code}"
    if isinstance(error, urllib.error.URLError):
        return "通信失敗(URLError)"
    if isinstance(error, TimeoutError):
        return "タイムアウト"
    if isinstance(error, PipelineError):
        return str(error)
    return f"通信失敗({type(error).__name__})"


def _replace_note(lead: dict[str, Any], prefix: str, message: str | None) -> None:
    lines = [line for line in str(lead.get("note", "")).splitlines() if line and not line.startswith(prefix)]
    if message:
        lines.append(f"{prefix}{message}")
    lead["note"] = "\n".join(lines)


def fill_descriptions(leads_path: str | Path | None = None) -> dict[str, int]:
    leads = load_leads(leads_path)
    filled = 0
    skipped = 0
    failed = 0
    for lead in leads:
        if str(lead.get("description", "")).strip():
            skipped += 1
            continue
        url = str(lead.get("url", "")).strip()
        try:
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise PipelineError("公式URLが不正です")
            request = urllib.request.Request(
                url,
                headers={"user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-encoding": "identity"},
            )
            page = _request_text(request, 20)
            description, reason = build_description(page)
            if not description:
                _replace_note(lead, "fill-desc: ", reason)
                failed += 1
                continue
            lead["description"] = description
            _replace_note(lead, "fill-desc: ", None)
            filled += 1
        except Exception as error:  # 1社の通信失敗で残りを止めない。
            _replace_note(lead, "fill-desc: ", _failure_label(error))
            failed += 1
    save_leads(leads, leads_path)
    print(f"説明文: 新規{filled}件 / 既存{skipped}件 / 未作成{failed}件")
    return {"filled": filled, "skipped": skipped, "failed": failed}


def _read_secret(path: str | Path, label: str) -> str:
    secret_path = Path(path).expanduser()
    try:
        secret = secret_path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise PipelineError(f"{label}を読めません: {type(error).__name__}") from error
    if not secret:
        raise PipelineError(f"{label}が空です")
    return secret


def _sample_payload(lead: dict[str, Any]) -> dict[str, str]:
    return {
        "storeName": str(lead.get("storeName", "")),
        "industry": str(lead.get("engineIndustry", "その他")),
        "catchphrase": str(lead.get("catchphrase", "")),
        "description": str(lead.get("description", "")),
        "colorTheme": str(lead.get("colorTheme", "落ち着いた")),
        "skeleton": str(lead.get("skeleton", "看板")),
        "sampleSource": "map",
    }


def _slug_from_sample(result: dict[str, Any], sample_url: str) -> str:
    slug = result.get("slug")
    if isinstance(slug, str) and re.fullmatch(r"[a-z0-9-]{4,80}", slug):
        return slug
    path_parts = [part for part in urllib.parse.urlsplit(sample_url).path.split("/") if part]
    candidate = path_parts[-1] if path_parts else ""
    return candidate if re.fullmatch(r"[a-z0-9-]{4,80}", candidate) else ""


def _unpublish_sample(slug: str, key: str) -> None:
    if not slug:
        raise PipelineError("見本slugを特定できません")
    result = _post_json(UNPUBLISH_API, {"slug": slug}, "x-batch-key", key, 20)
    if result.get("ok") is not True:
        raise PipelineError("掲載停止APIが失敗しました")


def create_samples(
    leads_path: str | Path | None = None,
    key_path: str | Path = BATCH_KEY_PATH,
) -> dict[str, int]:
    leads = load_leads(leads_path)
    generated = 0
    safe = 0
    rejected = 0
    failed = 0
    if not any(
        str(lead.get("description", "")).strip() and not str(lead.get("sample_url", "")).strip()
        for lead in leads
    ):
        print("見本: 生成0件 / 合格0件 / 掲載停止0件 / エラー0件")
        return {"generated": 0, "safe": 0, "rejected": 0, "failed": 0}

    key = _read_secret(key_path, "見本生成キー")

    for lead in leads:
        if not str(lead.get("description", "")).strip() or str(lead.get("sample_url", "")).strip():
            continue
        try:
            result = _post_json(SAMPLE_API, _sample_payload(lead), "x-batch-key", key, 60)
            sample_url = result.get("url")
            if not isinstance(sample_url, str):
                raise PipelineError("見本生成APIにurlがありません")
            parsed = urllib.parse.urlsplit(sample_url)
            if parsed.scheme != "https" or not parsed.netloc:
                raise PipelineError("見本URLが不正です")
            slug = _slug_from_sample(result, sample_url)
            generated += 1

            try:
                check_request = urllib.request.Request(
                    sample_url,
                    headers={"user-agent": USER_AGENT, "accept": "text/html", "accept-encoding": "identity"},
                )
                sample_html = _request_text(check_request, 20)
            except Exception as error:
                try:
                    _unpublish_sample(slug, key)
                    suffix = "・掲載停止済み"
                except Exception:
                    suffix = "・掲載停止にも失敗"
                lead.pop("sample_url", None)
                lead["sample_error"] = f"本文検査失敗: {_failure_label(error)}{suffix}"
                failed += 1
                save_leads(leads, leads_path)
                continue

            found = [word for word in FORBIDDEN_SAMPLE_WORDS if word in sample_html]
            if found:
                try:
                    _unpublish_sample(slug, key)
                    suffix = "（掲載停止済み）"
                except Exception:
                    suffix = "（掲載停止失敗）"
                lead.pop("sample_url", None)
                lead["sample_error"] = f"禁止語検出: {','.join(found)}{suffix}"
                rejected += 1
            else:
                lead["sample_url"] = sample_url
                lead.pop("sample_error", None)
                safe += 1
            save_leads(leads, leads_path)
        except Exception as error:
            lead.pop("sample_url", None)
            lead["sample_error"] = f"見本生成失敗: {_failure_label(error)}"
            failed += 1
            save_leads(leads, leads_path)

    print(f"見本: 生成{generated}件 / 合格{safe}件 / 掲載停止{rejected}件 / エラー{failed}件")
    return {"generated": generated, "safe": safe, "rejected": rejected, "failed": failed}


def email_slug(email: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", email.strip().lower()).strip("-")
    if not slug:
        slug = hashlib.sha256(email.encode("utf-8")).hexdigest()[:20]
    return slug[:154].rstrip("-")


def _cloud_payload(lead: dict[str, Any]) -> dict[str, str]:
    email = str(lead.get("email", "")).strip().lower()
    return {
        "id": f"b2b-{email_slug(email)}",
        "name": str(lead.get("name", "")),
        "email": email,
        "url": str(lead.get("url", "")),
        "evidence_url": str(lead.get("evidence_url", "")),
        "industry": "採用",
        "signal": str(lead.get("signal", "")),
        "sample_url": str(lead.get("sample_url", "")),
        "note": PUSH_NOTE,
    }


def push_leads(
    leads_path: str | Path | None = None,
    key_path: str | Path = ADMIN_KEY_PATH,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    leads = load_leads(leads_path)
    indexes = [
        index
        for index, lead in enumerate(leads)
        if str(lead.get("sample_url", "")).strip() and not str(lead.get("pushed_at", "")).strip()
    ]
    if not indexes:
        print("クラウド投入: 対象0件 / 追加0件")
        return {"received": 0, "added": 0, "skipped": 0}

    key = _read_secret(key_path, "クラウド管理キー")
    payload = [_cloud_payload(leads[index]) for index in indexes]
    try:
        result = _post_json(CLOUD_LEADS_API, payload, "x-admin-key", key, 60)
        if result.get("ok") is not True:
            raise PipelineError("クラウド投入APIが失敗しました")
    except Exception as error:
        label = _failure_label(error)
        for index in indexes:
            leads[index]["push_error"] = label
        save_leads(leads, leads_path)
        raise PipelineError(f"クラウド投入に失敗しました: {label}") from error

    timestamp = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    for index in indexes:
        leads[index]["pushed_at"] = timestamp
        leads[index].pop("push_error", None)
    save_leads(leads, leads_path)

    received = int(result.get("received", len(payload)))
    added = int(result.get("added", 0))
    skipped = int(result.get("skipped", max(0, received - added)))
    print(f"クラウド投入: 送信{len(payload)}件 / 受信{received}件 / 追加{added}件 / スキップ{skipped}件")
    return result


def show_status(leads_path: str | Path | None = None) -> dict[str, int]:
    leads = load_leads(leads_path)
    summary = {
        "total": len(leads),
        "described": sum(bool(str(lead.get("description", "")).strip()) for lead in leads),
        "sampled": sum(bool(str(lead.get("sample_url", "")).strip()) for lead in leads),
        "pushed": sum(bool(str(lead.get("pushed_at", "")).strip()) for lead in leads),
        "errors": sum(
            any(bool(str(lead.get(key, "")).strip()) for key in ("note", "sample_error", "push_error"))
            for lead in leads
        ),
    }
    print(
        f"全体{summary['total']}件 / desc埋まり{summary['described']}件 / "
        f"見本あり{summary['sampled']}件 / 投入済み{summary['pushed']}件 / エラー{summary['errors']}件"
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    parse_parser = subparsers.add_parser("parse", help="候補MarkdownをJSONへ変換")
    parse_parser.add_argument("md_path", help="候補Markdownのパス")
    subparsers.add_parser("fill-desc", help="公式サイトの記載だけで説明文を作成")
    subparsers.add_parser("samples", help="説明文のある候補の見本を生成・検査")
    subparsers.add_parser("push", help="合格した候補をfreehp-cloudへ投入")
    subparsers.add_parser("status", help="進捗件数を表示")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "parse":
            parse_markdown(args.md_path)
        elif args.command == "fill-desc":
            fill_descriptions()
        elif args.command == "samples":
            create_samples()
        elif args.command == "push":
            push_leads()
        elif args.command == "status":
            show_status()
    except PipelineError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
