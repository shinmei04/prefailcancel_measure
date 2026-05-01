---
marp: true
theme: default
paginate: true
size: 16:9
style: |
  :root {
    --navy: #0D1828;
    --blue: #2688B6;
    --cyan: #27CED7;
    --green: #279A6C;
    --pink: #EB4079;
    --gold: #D69D1F;
    --dark-gray: #465359;
    --mid-gray: #969FA7;
    --pale-gray: #DFE3E5;
    --text: #263238;
  }
  section {
    font-family: "Yu Gothic", "Hiragino Sans", "Meiryo UI", sans-serif;
    background: #ffffff;
    color: var(--text);
    padding: 58px 68px 54px;
    letter-spacing: 0.01em;
  }
  section::before {
    content: "";
    position: absolute;
    left: 42px;
    right: 42px;
    top: 24px;
    height: 7px;
    background:
      linear-gradient(90deg,
        var(--dark-gray) 0 28%,
        transparent 28% 30%,
        var(--navy) 30% 58%,
        transparent 58% 60%,
        var(--mid-gray) 60% 100%);
  }
  section.title {
    padding: 92px 76px 54px;
  }
  section.title h1 {
    color: var(--navy);
    font-size: 54px;
    line-height: 1.18;
    margin: 122px 0 34px;
    letter-spacing: 0.02em;
  }
  section.title p {
    color: var(--dark-gray);
    font-size: 22px;
    line-height: 1.65;
  }
  h1 {
    color: var(--navy);
    font-size: 40px;
    font-weight: 800;
    margin: 0 0 28px;
  }
  h1::after {
    content: "";
    display: block;
    width: 132px;
    height: 6px;
    margin-top: 13px;
    background: var(--blue);
  }
  h2 {
    color: var(--blue);
    font-size: 27px;
    margin: 0 0 14px;
  }
  p, li {
    font-size: 24px;
    line-height: 1.55;
  }
  strong {
    color: var(--blue);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 20px;
  }
  th {
    background: var(--navy);
    color: #fff;
    font-weight: 700;
  }
  th, td {
    padding: 12px 15px;
    border: 1.6px solid var(--pale-gray);
  }
  td {
    background: #fff;
  }
  blockquote {
    border-left: 8px solid var(--blue);
    background: #F4F7F8;
    padding: 18px 24px;
    margin: 24px 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 30px;
    align-items: stretch;
  }
  .card {
    background: #F7F9FA;
    border-left: 8px solid var(--blue);
    padding: 22px 26px;
  }
  .card.cyan {
    border-left-color: var(--cyan);
  }
  .card.pink {
    border-left-color: var(--pink);
  }
  .metric {
    font-size: 30px;
    font-weight: 800;
    color: var(--navy);
  }
  .lead {
    font-size: 30px;
    line-height: 1.5;
    font-weight: 700;
    color: var(--navy);
  }
  .small li, .small p {
    font-size: 19px;
  }
  .small table {
    font-size: 17px;
  }
  .small th, .small td {
    padding: 8px 10px;
  }
  .tight table {
    font-size: 18px;
  }
  .tight th, .tight td {
    padding: 9px 11px;
  }
  .note {
    color: var(--dark-gray);
    font-size: 20px;
  }
  .center {
    text-align: center;
  }
  img[alt~="center"] {
    display: block;
    margin: 0 auto;
  }
---

<!-- _class: title -->

# 日本語生成検索における<br>意図適応型GEOの提案

新美 昂正  
情報アーキテクチャ領域 / 稲村研究室

---

# 出発点: 検索で「見える場所」が変わった

![w:980 center](assets/seo_to_geo.svg)

---

# 生成検索では、順位だけでは不十分

従来のSEOでは、検索結果ページで**上位に表示されること**が中心だった。

生成検索では、ユーザが直接見るのは検索結果一覧ではなく、生成エンジンが統合した回答である。

<p class="lead">つまり、Web文書は「検索結果にあるか」だけでなく、回答内で引用・要約されるかが重要になる。</p>

---

# GEOとは何か

**GEO（Generative Engine Optimization）**は、生成検索エンジンの回答内でWeb文書の可視性を高めるための最適化である。

![w:980 center](assets/geo_explanation_cards.svg)

<p class="note">生成エンジン自体を変更するのではなく、入力される文書表現を最適化する。</p>

---

# 関連研究: 既存GEOで分かっていること

Aggarwal et al. は、Web文書に9種類のGEO操作を適用し、生成回答内での可視性が変化することを示した。

<div class="small">

| 分類 | 手法 | 内容 |
|---|---|---|
| 信頼性を足す | Cite Sources | 信頼できる出典・参照元を追加する |
| 信頼性を足す | Quotation Addition | 権威ある人物・資料からの引用句を追加する |
| 根拠を足す | Statistics Addition | 数値・統計・客観的な事実を追加する |
| 文体を変える | Authoritative / Fluency / Easy-to-Understand | 専門的・自然・平易な文体に変える |
| 語彙を変える | Technical Terms / Unique Words | 専門用語や多様な語彙を増やす |
| 従来SEO系 | Keyword Stuffing | クエリ関連キーワードを多く入れる |

</div>

---

# ただし、既存GEOをそのまま使うには課題がある

<div class="grid">

<div class="card">

<div class="metric">課題1: 日本語への適用</div>

既存GEOは主に英語環境で評価されており、日本語文書でも同じ効果が出るかは未確認である。

</div>

<div class="card cyan">

<div class="metric">課題2: 検索意図への適応</div>

どのような質問に、どのGEO操作が有効かという対応関係は十分に整理されていない。

</div>

</div>

<p class="note">本研究は、この2つの課題を順に検証する。</p>

---

# なぜ日本語では再設計が必要か

英語向けのGEO操作を日本語にそのまま移すと、文書変換と評価の両方でずれが生じる可能性がある。

<div class="grid">

<div class="card">

<div class="metric">文書表現の違い</div>

- 語境界が明確ではない
- 主語省略が多い
- 敬体・常体の使い分けがある

</div>

<div class="card cyan">

<div class="metric">評価指標の違い</div>

- 英語の単語数評価をそのまま使いにくい
- 文字数・形態素・文単位への調整が必要
- 引用位置や要約利用量の定義が必要

</div>

</div>

---

# 本研究の問い

<div class="grid">

<div class="card">

<div class="metric">RQ1</div>

既存GEO手法は、日本語生成検索でも対象文書の可視性を高めるか。

</div>

<div class="card cyan">

<div class="metric">RQ2</div>

検索意図ごとにGEO操作を切り替えることで、固定的なGEOより可視性を高められるか。

</div>

</div>

<p class="lead">本研究の主張は、検索意図に応じてGEO操作を切り替える必要がある、という点にある。</p>

---

# 提案: 意図適応型GEO

固定的に同じGEO操作を使うのではなく、検索意図ごとに操作を切り替える。

![w:860 center](assets/intent_adaptive_geo.svg)

<p class="note">人手ラベル版で上限性能を確認し、ルールベース分類・LLM分類で実運用に近い条件も確認する。</p>

---

# 検索意図はどう分類するか

<div class="small">

| 検索意図 | 判定基準 | クエリ例 |
|---|---|---|
| 事実確認型 | 日付・定義・数値・固有事実を問う | 「○○はいつ開始されたか」 |
| 比較型 | 複数対象の違い・優劣・選択を問う | 「AとBの違いは何か」 |
| 解説型 | 概念や仕組みの理解を求める | 「○○とは何か」 |
| 意見・論点整理型 | 賛否・課題・論点を整理する | 「○○の是非は」 |

</div>

<p class="note">まず人手で分類基準を作成し、その後ルールベース分類とLLM分類を比較する。</p>

---

# 意図ごとに有効な操作は異なるはず

| 検索意図 | 有効そうなGEO操作 |
|---|---|
| 事実確認型 | 出典追加、統計追加、日付・根拠の明示 |
| 比較型 | 比較軸の明示、表形式化、見出し構造化 |
| 解説型 | 流暢化、やさしい表現化、段階的説明 |
| 意見・論点整理型 | 引用句追加、権威化、論点整理 |

<p class="note">この対応関係が、固定GEOとの差を生むかを実験で確認する。</p>

---

# 関連研究との位置づけ

生成検索では、質問に応じて検索・生成を変える研究が進んでいる。  
本研究は、その考え方を**文書最適化側**へ拡張する。

| 研究 | 位置づけ | 本研究との関係 |
|---|---|---|
| Self-RAG | 必要に応じて検索し、生成結果を自己反省する | 質問に応じて処理を変える発想 |
| RankRAG | 検索文脈の順位付けと回答生成を統合 | 質問に応じて使う文脈を選ぶ発想 |
| Evaluating Verifiability | 生成検索の引用の網羅性・正確性を評価 | 回答内引用の重要性を示す |
| G-Eval | LLMを用いたNLG評価 | 主観的品質評価の参考 |

---

# 実験の基本方針

![w:980 center](assets/evaluation_pipeline.svg)

<p class="note">検索結果文脈を固定し、対象文書のみを変換することで、文書表現の違いによる可視性変化を比較する。</p>

---

# 実験対象とする生成検索環境

本研究では、実運用サービスを直接対象にする前に、再現可能なRAG型生成検索環境を構築する。

<div class="grid">

<div class="card">

<div class="metric">主実験</div>

日本語クエリ → 5件の文書 → 1件のみGEO操作 → LLMで引用付き回答を生成 → 対象文書の利用度を評価

</div>

<div class="card cyan">

<div class="metric">補助実験</div>

実運用されている生成検索サービスでも一部比較し、再現環境で得た傾向が実環境でも見られるか確認する。

</div>

</div>

---

# 日本語クエリ・文書集合の設計

<div class="tight">

| 項目 | 設計案 |
|---|---|
| 検索意図 | 事実確認型、比較型、解説型、意見・論点整理型 |
| パイロット実験 | 4意図 × 10問 = 40問 |
| 本実験 | 4意図 × 50問 = 200問 |
| 文書集合 | 各クエリに対して5文書 |
| 対象文書 | 5文書中1件 |
| 文書順序 | 条件間で固定 |
| 生成回数 | 各条件3〜5回 |

</div>

<p class="note">まず小規模なパイロット実験で傾向を確認し、その後クエリ数と条件数を拡張する。</p>

---

# 比較する条件

| 条件 | 内容 | 目的 |
|---|---|---|
| 無変換 | 元の日本語文書をそのまま使う | ベースライン |
| 既存GEO | 9種類の既存GEO操作を個別に適用 | 日本語環境での有効性を確認 |
| 固定GEO | 全クエリに同じGEO操作を適用 | 固定的な最適化の基準 |
| 意図適応型GEO | 検索意図ごとに操作を切り替える | 提案手法の有効性を確認 |

<p class="note">固定GEOの例: Cite Sources + Statistics Addition + Fluency Optimization</p>

---

# 日本語向け可視性指標

<div class="small">

| 指標 | 計算・確認方法 |
|---|---|
| 引用率 | 対象文書が回答中で1回以上引用された割合 |
| 引用シェア | 回答中の全引用のうち、対象文書への引用が占める割合 |
| 利用量 | 対象文書を引用する文の文字数・形態素数・文数 |
| 位置 | 対象文書が回答の何文目で初めて引用されたか |
| 日本語版Position-Adjusted Count | 回答前半に現れた対象文書由来の文ほど高く評価 |
| 主観的評価 | 関連性、影響度、独自性をLLM評価と一部人手評価で確認 |

</div>

---

# 評価で見ること

<div class="grid">

<div class="card">

<div class="metric">RQ1の検証</div>

無変換と既存GEOを比較し、日本語環境で有効な操作と効きにくい操作を確認する。

</div>

<div class="card cyan">

<div class="metric">RQ2の検証</div>

固定GEOと意図適応型GEOを比較し、検索意図別最適化の有効性を確認する。

</div>

</div>

---

# 期待される貢献

1. 日本語生成検索におけるGEOの有効性と限界を明らかにする
2. 日本語向けの可視性評価指標を整理する
3. 検索意図とGEO操作の対応関係を実験的に示す
4. 生成検索時代の日本語Web文書最適化の設計指針を提案する

---

# 参考文献

<div class="small">

- Aggarwal et al. “GEO: Generative Engine Optimization.” KDD 2024.
- Asai et al. “Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection.” ICLR 2024.
- Yu et al. “RankRAG: Unifying Context Ranking with Retrieval-Augmented Generation in LLMs.” NeurIPS 2024.
- Liu, Zhang, and Liang. “Evaluating Verifiability in Generative Search Engines.” Findings of EMNLP 2023.
- Liu et al. “G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment.” EMNLP 2023.

</div>

---
## 固定GEOの課題と提案手法

### 固定GEOの課題
既存GEOは，文書に対して出典追加・統計追加・流暢化などを行うことで，
生成回答内での可視性を高める。

しかし，すべてのクエリに同じ操作を適用すると，
**クエリが求める回答形式と文書変換がずれる**可能性がある。

<div class="grid">

<div class="card">

<div class="metric">ミスマッチの例</div>

- 比較クエリには比較軸が必要
- 事実確認クエリには根拠・出典が必要
- 解説クエリには平易な説明が必要
- 論点整理クエリには賛否・論点構造が必要

</div>

<div class="card cyan">

<div class="metric">提案手法</div>

**意図適応型GEO**

クエリの検索意図を分類し，
意図ごとに適したGEO操作を選択する。

</div>

</div>

**→ 固定的な変換ではなく，回答生成に必要な情報形式に合わせて文書を最適化する。**