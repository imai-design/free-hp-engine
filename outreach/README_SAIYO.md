`python3 outreach/saiyo_pipeline.py parse "$HOME/Documents/個人メモ/候補企業_公開メール_採用装置.md"` — 候補表をJSON化
`python3 outreach/saiyo_pipeline.py fill-desc` — 公式サイトの記載だけで説明文を補完
`python3 outreach/saiyo_pipeline.py samples` — 見本を生成し禁止語を検査
`python3 outreach/saiyo_pipeline.py push` — 合格済み見本をクラウド台帳へ冪等投入
`python3 outreach/saiyo_pipeline.py status` — 件数とエラー状況を表示
