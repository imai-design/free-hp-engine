import contextlib
import datetime as dt
import io
import json
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


if __name__ == "__main__":
    unittest.main()
