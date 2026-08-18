-- partner_key(紹介パートナーの生の鍵)をCSV/JSONへそのまま出力していたのを、
-- SHA-256先頭16桁のハッシュ列に切り替える(CSV流出がそのまま/api/sampleの生成権限の流出に
-- 直結していたため)。既存のpartner_key列は残すが、今後の書き込みでは使わずNULLのままにする
-- (過去データの後方互換のための保持。読み出し側もpartner_key_hashだけを使う)。
ALTER TABLE applications ADD COLUMN partner_key_hash TEXT;
