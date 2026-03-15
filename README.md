# Premeasure 実行手順

このプロジェクトは Puppeteer を使って計測を行い、結果を raw.csv に出力します。

## 前提

- Node.js と npm が使えること
- 初回のみ依存関係をインストール

実行コマンド:

npm install

## 基本実行

通常計測:

npm run measure

同等コマンド:

npm start

## まず 1 回だけ試す

設定確認や疎通確認向け:

npm run measure:one

## cancel_delay シナリオで実行

attack 側の停止遅延を計測:

npm run measure:cancel-delay

## 対象ページを絞って実行

Light のみ:

npm run measure -- Light

Light と Medium:

npm run measure -- Light,Medium

指定可能な対象名:

- Light
- Medium
- Heavy

## 出力

- 計測結果は raw.csv に追記保存されます

## 参考

登録済みスクリプト一覧を確認する場合:

npm run
