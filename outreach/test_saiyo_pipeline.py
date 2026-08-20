import contextlib
import datetime as dt
import io
import json
import re
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from outreach import saiyo_pipeline as pipeline


class FakeHeaders(dict):
    def get_content_charset(self):
        content_type = self.get("content-type", "")
        return "utf-8" if "charset=utf-8" in content_type else None


class FakeResponse:
    def __init__(self, body, content_type="application/json; charset=utf-8"):
        self.body = body.encode("utf-8") if isinstance(body, str) else body
        self.headers = FakeHeaders({"content-type": content_type})

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, amount=-1):
        return self.body if amount < 0 else self.body[:amount]


class SaiyoPipelineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.leads_path = self.root / "saiyo_leads.json"

    def write_leads(self, leads):
        pipeline.save_leads(leads, self.leads_path)

    def read_leads(self):
        return json.loads(self.leads_path.read_text(encoding="utf-8"))

    def test_parse_converts_markdown_columns(self):
        markdown = """\
| # | 名称 | 業種 | 所在地 | 公式URL | 代表メール | メールの根拠URL | 営業拒否表示 | 求人シグナル | HPの困りごと | 規模 | HTTP確認 |
|---:|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **青空建設株式会社** | 総合建設業 | 東京都世田谷区三軒茶屋1-2-3 | [公式](https://aozora.example/) | INFO@AOZORA.EXAMPLE | https://aozora.example/contact | なし | 現場監督を募集中 | 採用ページへの導線がない | 30名 | 200 |
"""
        source = self.root / "candidates.md"
        source.write_text(markdown, encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            leads = pipeline.parse_markdown(source, self.leads_path)

        self.assertEqual(len(leads), 1)
        lead = leads[0]
        self.assertEqual(lead["name"], "青空建設株式会社")
        self.assertEqual(lead["email"], "info@aozora.example")
        self.assertEqual(lead["url"], "https://aozora.example/")
        self.assertEqual(lead["evidence_url"], "https://aozora.example/contact")
        self.assertEqual(lead["industry"], "採用")
        self.assertEqual(lead["storeName"], lead["name"])
        self.assertEqual(lead["catchphrase"], "世田谷区の建設会社")
        self.assertIn("現場監督を募集中", lead["signal"])
        self.assertIn("採用ページへの導線がない", lead["signal"])
        self.assertLessEqual(len(lead["signal"]), 80)
        self.assertEqual(lead["description"], "")
        self.assertEqual(lead["skeleton"], "看板")
        self.assertEqual(lead["colorTheme"], "落ち着いた")
        self.assertEqual(lead["engineIndustry"], "不動産・建設")
        self.assertEqual(lead["note"], "")
        self.assertEqual(self.read_leads(), leads)

    def test_parse_strips_japanese_note_from_url_cells(self):
        markdown = """\
| # | 名称 | 業種 | 所在地 | 公式URL | 代表メール | メールの根拠URL | 営業拒否表示 | 求人シグナル | HPの困りごと | 規模 | HTTP確認 |
|---:|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **誠和電工株式会社** | 電気工事業 | 神奈川県川崎市 | http://www.seiwabeatle.com/（https://は証明書期限切れで接続不可 | uketsuke_info@seiwaweb.jp | http://www.seiwabeatle.com/saiyou.html（こちらでも直接grep再確認済み | なし | 現場監督を募集中 | 採用ページへの導線がない | 30名 | 200 |
"""
        source = self.root / "candidates.md"
        source.write_text(markdown, encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            leads = pipeline.parse_markdown(source, self.leads_path)

        self.assertEqual(len(leads), 1)
        lead = leads[0]
        self.assertEqual(lead["url"], "http://www.seiwabeatle.com/")
        self.assertEqual(lead["evidence_url"], "http://www.seiwabeatle.com/saiyou.html")

    def test_fill_desc_builds_two_sentences_and_skips_failure(self):
        self.write_leads(
            [
                {"name": "青空建設", "url": "https://good.example/", "description": "", "note": ""},
                {"name": "失敗会社", "url": "https://bad.example/", "description": "", "note": ""},
            ]
        )
        page = """
<!doctype html><html><head>
<title>青空建設株式会社｜地域の建築と土木を担う会社</title>
<meta name="description" content="東京都内で公共施設の建築工事と道路の土木工事を手がけています。">
</head><body><main><p>昭和五十年の創業以来、安全管理を大切にして施工しています。</p></main></body></html>
"""
        responses = [FakeResponse(page, "text/html; charset=utf-8"), urllib.error.URLError("offline")]

        with mock.patch.object(urllib.request, "urlopen", side_effect=responses) as urlopen:
            with contextlib.redirect_stdout(io.StringIO()):
                result = pipeline.fill_descriptions(self.leads_path)

        leads = self.read_leads()
        self.assertEqual(result, {"filled": 1, "skipped": 0, "failed": 1})
        self.assertGreaterEqual(len(leads[0]["description"]), 60)
        self.assertLessEqual(len(leads[0]["description"]), 140)
        self.assertEqual(leads[0]["description"].count("。"), 2)
        self.assertIn("公共施設の建築工事", leads[0]["description"])
        self.assertEqual(leads[1]["description"], "")
        self.assertIn("fill-desc: 通信失敗", leads[1]["note"])
        self.assertEqual(urlopen.call_args_list[0].kwargs["timeout"], 20)
        first_request = urlopen.call_args_list[0].args[0]
        self.assertTrue(first_request.get_header("User-agent"))

    def test_samples_checks_html_and_unpublishes_forbidden_sample(self):
        self.write_leads(
            [
                {
                    "name": "安全会社",
                    "description": "事実だけの十分な説明文です。",
                    "storeName": "安全会社",
                    "engineIndustry": "その他",
                    "catchphrase": "港区のシステム開発会社",
                    "colorTheme": "落ち着いた",
                    "skeleton": "看板",
                },
                {
                    "name": "要停止会社",
                    "description": "事実だけの十分な説明文です。",
                    "storeName": "要停止会社",
                    "engineIndustry": "不動産・建設",
                    "catchphrase": "江東区の運送会社",
                    "colorTheme": "落ち着いた",
                    "skeleton": "看板",
                },
                {"name": "説明なし", "description": ""},
            ]
        )
        key_path = self.root / "batch.key"
        key_path.write_text("very-secret-batch-key\n", encoding="utf-8")
        responses = [
            FakeResponse('{"url":"https://freehp.jp/s/safe-one","slug":"safe-one"}'),
            FakeResponse("<html><body>会社の採用情報</body></html>", "text/html; charset=utf-8"),
            FakeResponse('{"url":"https://freehp.jp/s/bad-one","slug":"bad-one"}'),
            FakeResponse("<html><body>お店へのご来店は無料です</body></html>", "text/html; charset=utf-8"),
            FakeResponse('{"ok":true}'),
        ]

        with mock.patch.object(urllib.request, "urlopen", side_effect=responses) as urlopen:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = pipeline.create_samples(self.leads_path, key_path)

        leads = self.read_leads()
        self.assertEqual(result, {"generated": 2, "safe": 1, "rejected": 1, "failed": 0})
        self.assertEqual(leads[0]["sample_url"], "https://freehp.jp/s/safe-one")
        self.assertNotIn("sample_url", leads[1])
        self.assertIn("お店", leads[1]["sample_error"])
        self.assertNotIn("very-secret-batch-key", output.getvalue())
        self.assertEqual(urlopen.call_count, 5)

        sample_request = urlopen.call_args_list[0].args[0]
        sample_payload = json.loads(sample_request.data.decode("utf-8"))
        self.assertEqual(
            sample_payload,
            {
                "storeName": "安全会社",
                "industry": "その他",
                "catchphrase": "港区のシステム開発会社",
                "description": "事実だけの十分な説明文です。",
                "colorTheme": "落ち着いた",
                "skeleton": "看板",
                "sampleSource": "map",
            },
        )
        self.assertEqual(sample_request.get_header("X-batch-key"), "very-secret-batch-key")
        self.assertTrue(sample_request.get_header("User-agent"))

        unpublish_request = urlopen.call_args_list[4].args[0]
        self.assertEqual(unpublish_request.full_url, pipeline.UNPUBLISH_API)
        self.assertEqual(json.loads(unpublish_request.data.decode("utf-8")), {"slug": "bad-one"})

    def test_push_posts_expected_payload_and_marks_only_new_items(self):
        lead = {
            "name": "採用テック株式会社",
            "email": "INFO@SAIYO.EXAMPLE",
            "url": "https://saiyo.example/",
            "evidence_url": "https://saiyo.example/contact",
            "industry": "採用",
            "signal": "求人:エンジニア募集中／HP:採用導線がない",
            "sample_url": "https://freehp.jp/s/saiyo-tech",
        }
        self.write_leads([lead, {**lead, "email": "done@example.jp", "pushed_at": "2026-08-19T00:00:00Z"}])
        key_path = self.root / "admin.key"
        key_path.write_text("very-secret-admin-key", encoding="utf-8")
        response = FakeResponse('{"ok":true,"received":1,"added":1,"skipped":0}')
        fixed_now = dt.datetime(2026, 8, 20, 3, 4, 5, tzinfo=dt.timezone.utc)

        with mock.patch.object(urllib.request, "urlopen", return_value=response) as urlopen:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = pipeline.push_leads(self.leads_path, key_path, fixed_now)

        self.assertEqual(result["added"], 1)
        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            payload,
            [
                {
                    "id": "b2b-info-saiyo-example",
                    "name": "採用テック株式会社",
                    "email": "info@saiyo.example",
                    "url": "https://saiyo.example/",
                    "evidence_url": "https://saiyo.example/contact",
                    "industry": "採用",
                    "signal": "求人:エンジニア募集中／HP:採用導線がない",
                    "sample_url": "https://freehp.jp/s/saiyo-tech",
                    "note": pipeline.PUSH_NOTE,
                }
            ],
        )
        self.assertEqual(request.get_header("X-admin-key"), "very-secret-admin-key")
        self.assertTrue(request.get_header("User-agent"))
        self.assertNotIn("very-secret-admin-key", output.getvalue())
        saved = self.read_leads()
        self.assertEqual(saved[0]["pushed_at"], "2026-08-20T03:04:05Z")
        self.assertEqual(saved[1]["pushed_at"], "2026-08-19T00:00:00Z")

        with mock.patch.object(urllib.request, "urlopen") as second_urlopen:
            with contextlib.redirect_stdout(io.StringIO()):
                second = pipeline.push_leads(self.leads_path, self.root / "missing.key")
        self.assertEqual(second, {"received": 0, "added": 0, "skipped": 0})
        second_urlopen.assert_not_called()

    def test_status_counts_each_pipeline_stage_and_errors(self):
        self.write_leads(
            [
                {"description": "説明", "sample_url": "https://freehp.jp/s/one", "pushed_at": "2026-08-20T00:00:00Z"},
                {"description": "説明", "sample_error": "禁止語検出"},
                {"description": "", "note": "fill-desc: 本文が薄い"},
            ]
        )

        with contextlib.redirect_stdout(io.StringIO()):
            summary = pipeline.show_status(self.leads_path)

        self.assertEqual(summary, {"total": 3, "described": 2, "sampled": 1, "pushed": 1, "errors": 2})

    # --- 2026-08-20〜: 仮名見本＋PNG撮影方式（相手の社名を使った見本の無断公開への抗議を受けて追加） ---

    def test_kamei_store_name_never_contains_real_name(self):
        self.assertEqual(pipeline.kamei_store_name("建設会社"), "◯◯建設（見本）")
        self.assertEqual(pipeline.kamei_store_name("運送会社"), "◯◯運送（見本）")
        self.assertEqual(pipeline.kamei_store_name("介護事業所"), "◯◯ケアサービス（見本）")
        self.assertEqual(pipeline.kamei_store_name("システム開発会社"), "◯◯システム（見本）")
        self.assertEqual(pipeline.kamei_store_name("製造会社"), "◯◯製作所（見本）")
        # KAMEI_WORDSに無いラベルでも「会社」を機械的に外すだけで、相手の実名を渡す入口がない。
        self.assertEqual(pipeline.kamei_store_name("特殊会社"), "◯◯特殊（見本）")

    def test_split_catchphrase_extracts_municipality_and_label(self):
        self.assertEqual(pipeline.split_catchphrase("江戸川区の建設会社"), ("江戸川区", "建設会社"))
        self.assertEqual(pipeline.split_catchphrase("船橋市の運送会社"), ("船橋市", "運送会社"))
        self.assertEqual(pipeline.split_catchphrase(""), ("", ""))
        self.assertEqual(pipeline.split_catchphrase("形式不正"), ("", ""))

    def test_build_generic_description_has_no_lead_specific_facts(self):
        description = pipeline.build_generic_description("船橋市", "建設会社")
        self.assertEqual(
            description,
            "船橋市を中心に、土木工事と建築工事を手がける建設会社です。"
            "道路や上下水道などの土木工事から、建物にともなう鳶・鍛冶工事まで対応しています。",
        )
        self.assertIsNone(re.search(r"\d", description))  # 創業年など相手固有の数字が入らない
        for forbidden in pipeline.FORBIDDEN_SAMPLE_WORDS:
            self.assertNotIn(forbidden, description)
        # 「見本」「実際の会社名」等のメタ文はエンジン側QAに「事業内容と対応していない」と
        # 弾かれるHTTP 422の原因だったため、業種の紹介文にはメタ文を一切含めない。
        self.assertNotIn("見本", description)
        self.assertNotIn("実際の会社名", description)

    def test_build_generic_description_per_industry(self):
        cases = {
            "運送会社": (
                "浦安市に拠点を置き、一般貨物の運送を手がける運送会社です。"
                "企業向けの定期便やスポット便のほか、倉庫での保管・仕分けにも対応しています。"
            ),
            "倉庫会社": (
                "浦安市に拠点を置き、一般貨物の運送を手がける運送会社です。"
                "企業向けの定期便やスポット便のほか、倉庫での保管・仕分けにも対応しています。"
            ),
            "介護事業所": (
                "浦安市で高齢者向けの介護サービスを行う事業所です。"
                "デイサービスや訪問介護を通じて、住み慣れた地域で暮らし続けられるよう支えています。"
            ),
            "システム開発会社": (
                "浦安市に拠点を置き、業務システムの受託開発を手がける会社です。"
                "要件の整理から設計・開発・保守まで一貫して対応しています。"
            ),
            "製造会社": (
                "浦安市に工場を構え、金属部品の加工・製造を手がける会社です。"
                "試作から量産まで、図面にもとづく加工に対応しています。"
            ),
            "特殊会社": (
                "浦安市に拠点を置く会社です。地域のお客さまに向けて、日々の仕事を丁寧に続けています。"
            ),
        }
        for industry_label, expected in cases.items():
            with self.subTest(industry_label=industry_label):
                description = pipeline.build_generic_description("浦安市", industry_label)
                self.assertEqual(description, expected)
                self.assertNotIn("見本", description)
                self.assertNotIn("実際の会社名", description)

    def test_anonymized_sample_payload_excludes_real_name_and_facts(self):
        lead = {
            "name": "有限会社小田原建設",
            "storeName": "有限会社小田原建設",
            "catchphrase": "江戸川区の建設会社",
            "description": "江戸川区の総合土木会社。1994年の創業以来、土木工事を手がけている。",
            "engineIndustry": "不動産・建設",
            "colorTheme": "落ち着いた",
            "skeleton": "看板",
        }
        payload = pipeline.anonymized_sample_payload(lead)
        self.assertEqual(payload["storeName"], "◯◯建設（見本）")
        self.assertNotIn("小田原", payload["storeName"])
        self.assertNotIn("小田原", payload["description"])
        self.assertNotIn("1994", payload["description"])
        self.assertNotEqual(payload["description"], lead["description"])
        self.assertEqual(payload["catchphrase"], "江戸川区の建設会社")
        self.assertEqual(payload["industry"], "不動産・建設")

        self.assertIsNone(pipeline.anonymized_sample_payload({"catchphrase": ""}))

    def test_strip_sample_url_marks_removed_only_when_present(self):
        with_url = {"sample_url": "https://freehp.jp/s/old-real-name"}
        self.assertTrue(pipeline.strip_sample_url(with_url))
        self.assertNotIn("sample_url", with_url)
        self.assertTrue(with_url["sample_url_removed"])

        without_url = {"name": "x"}
        self.assertFalse(pipeline.strip_sample_url(without_url))
        self.assertNotIn("sample_url_removed", without_url)

    def test_create_sample_screenshots_generates_captures_and_unpublishes(self):
        self.write_leads(
            [
                {
                    "name": "有限会社小田原建設",
                    "catchphrase": "江戸川区の建設会社",
                    "engineIndustry": "不動産・建設",
                    "colorTheme": "落ち着いた",
                    "skeleton": "看板",
                    "sample_url": "https://free-hp-engine.ryoseiworld.workers.dev/s/old-real-name",
                }
            ]
        )
        key_path = self.root / "batch.key"
        key_path.write_text("very-secret-batch-key\n", encoding="utf-8")
        output_dir = self.root / "samples_png"
        responses = [
            FakeResponse('{"url":"https://freehp.jp/s/kamei-one","slug":"kamei-one"}'),
            FakeResponse('{"ok":true}'),
        ]

        captured: dict = {}

        def fake_capture(url, output_path, width=pipeline.SAMPLE_SCREENSHOT_WIDTH):
            captured["url"] = url
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"PNG-DATA")

        with mock.patch.object(urllib.request, "urlopen", side_effect=responses) as urlopen:
            with mock.patch.object(pipeline, "capture_screenshot", side_effect=fake_capture) as capture_mock:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = pipeline.create_sample_screenshots(self.leads_path, key_path, output_dir)

        self.assertEqual(result, {"generated": 1, "reused": 0, "failed": 0})
        leads = self.read_leads()
        expected_path = output_dir / "建設_江戸川区.png"
        self.assertEqual(leads[0]["sample_png"], str(expected_path))
        self.assertTrue(expected_path.exists())
        self.assertNotIn("sample_url", leads[0])
        self.assertTrue(leads[0]["sample_url_removed"])
        self.assertNotIn("very-secret-batch-key", output.getvalue())

        capture_mock.assert_called_once()
        self.assertEqual(captured["url"], "https://freehp.jp/s/kamei-one")

        # 撮影後には必ずunpublishが呼ばれる
        self.assertEqual(urlopen.call_count, 2)
        create_request = urlopen.call_args_list[0].args[0]
        create_payload = json.loads(create_request.data.decode("utf-8"))
        self.assertEqual(create_payload["storeName"], "◯◯建設（見本）")
        self.assertNotIn("小田原", json.dumps(create_payload, ensure_ascii=False))
        unpublish_request = urlopen.call_args_list[1].args[0]
        self.assertEqual(unpublish_request.full_url, pipeline.UNPUBLISH_API)
        self.assertEqual(json.loads(unpublish_request.data.decode("utf-8")), {"slug": "kamei-one"})

    def test_create_sample_screenshots_reuses_cached_png_without_network(self):
        self.write_leads(
            [{"name": "テスト運送株式会社", "catchphrase": "船橋市の運送会社", "engineIndustry": "その他"}]
        )
        output_dir = self.root / "samples_png"
        output_dir.mkdir(parents=True)
        cached_path = output_dir / "運送_船橋市.png"
        cached_path.write_bytes(b"CACHED")
        key_path = self.root / "batch.key"  # 使われない想定（中身は空でよい）

        with mock.patch.object(urllib.request, "urlopen") as urlopen:
            with contextlib.redirect_stdout(io.StringIO()):
                result = pipeline.create_sample_screenshots(self.leads_path, key_path, output_dir)

        self.assertEqual(result, {"generated": 0, "reused": 1, "failed": 0})
        urlopen.assert_not_called()
        leads = self.read_leads()
        self.assertEqual(leads[0]["sample_png"], str(cached_path))

    def test_create_sample_screenshots_unpublishes_even_if_capture_fails(self):
        self.write_leads(
            [{"name": "テストケア株式会社", "catchphrase": "柏市の介護事業所", "engineIndustry": "医療・クリニック"}]
        )
        key_path = self.root / "batch.key"
        key_path.write_text("very-secret-batch-key", encoding="utf-8")
        output_dir = self.root / "samples_png"
        responses = [
            FakeResponse('{"url":"https://freehp.jp/s/kamei-fail","slug":"kamei-fail"}'),
            FakeResponse('{"ok":true}'),
        ]

        with mock.patch.object(urllib.request, "urlopen", side_effect=responses) as urlopen:
            with mock.patch.object(pipeline, "capture_screenshot", side_effect=RuntimeError("boom")):
                with contextlib.redirect_stdout(io.StringIO()):
                    result = pipeline.create_sample_screenshots(self.leads_path, key_path, output_dir)

        self.assertEqual(result, {"generated": 0, "reused": 0, "failed": 1})
        # 撮影に失敗してもunpublishは必ず呼ばれる
        self.assertEqual(urlopen.call_count, 2)
        unpublish_request = urlopen.call_args_list[1].args[0]
        self.assertEqual(json.loads(unpublish_request.data.decode("utf-8")), {"slug": "kamei-fail"})
        leads = self.read_leads()
        self.assertNotIn("sample_png", leads[0])
        self.assertIn("撮影失敗", leads[0]["sample_error"])
        self.assertFalse((output_dir / "ケアサービス_柏市.png").exists())


if __name__ == "__main__":
    unittest.main()
