# Photo2wire

写真を針金細工風の一筆書き線画に変換するWebアプリケーション。

## 概要

Photo2wireは、通常の写真をシンプルな一筆書き線画に変換し、針金細工の製作に活用できるツールです。全ての処理はブラウザ内で完結し、サーバー不要で完全にローカルで動作します。

## 使い方

1. サーバーを起動
   ```bash
   python3 serve.py
   ```

2. ブラウザでアクセス
   ```
   http://localhost:8932/
   ```

3. 使用フロー
   - **ステップ1**: クリックまたはドラッグ＆ドロップで写真を選択
   - **ステップ2**: スライダーで変換パラメータを調整
     - 被写体の自動切り抜き
     - つなぎ線の色分け表示
     - 単純化度、内部線の量、線の太さ
   - **ステップ3**: SVGまたはPNG形式でダウンロード、または描き順アニメーションを表示

## 処理の流れ

1. **被写体自動切り抜き** (オプション)
   - onnxruntime-web + U2-Netp画像セグメンテーションモデルで背景を除去

2. **エッジ検出**
   - Difference of Gaussians (DoG) フィルタで線を抽出

3. **細線化・ベクター化**
   - 細線化処理で線を1ピクセル幅に
   - 端点・分岐点を検出し線分を抽出
   - Douglas-Peucker単純化でポイント数を削減

4. **一筆書き化**
   - 複数の線分を貪欲法で連結
   - つなぎ線を最小化
   - 2-opt最適化で順序を改善

5. **スムージング**
   - Chaikinアルゴリズムで滑らかな曲線に

6. **SVG出力**
   - 線の順序情報を保持したSVG形式で生成

## 機能

- **被写体自動切り抜き**: AI (U2-Netp) により背景を自動除去
- **完全な一筆書き**: つなぎ線を最小化し、1本の連続線で描けるように最適化
- **パラメータ調整**: 単純化度、内部線の量、線の太さをリアルタイムで調整
- **針金必要長の計算**: 作品の実寸 (cm) を指定し、必要な針金の長さを自動計算
- **複数形式でのダウンロード**:
  - SVG: ベクター形式、ほぼ全ての設計ツール・CADで使用可能
  - PNG: ラスター形式、SNS投稿や印刷に対応
- **描き順アニメーション**: 線を描く順序を視覚化（シミュレーション用）

## 技術スタック

- **HTML / CSS / JavaScript (vanilla)**
  - ビルドツール不要、CDNのみで動作

- **onnxruntime-web** (v1.19.2)
  - ブラウザ上で機械学習モデルを実行

- **U2-Netp** (Apache 2.0 ライセンス)
  - セグメンテーションモデル、models/u2netp.onnx に同梱

- **Image Processing Algorithms**
  - DoG (Difference of Gaussians) エッジ検出
  - Skeletonization (細線化)
  - Douglas-Peucker 単純化
  - 2-opt 巡回セールスマン問題最適化
  - Chaikin スムージング

## ディレクトリ構成

```
Photo2wire/
├── index.html          # メインHTMLファイル
├── css/
│   └── style.css       # スタイルシート
├── js/
│   ├── main.js         # エントリーポイント
│   ├── imageProcessor.js
│   ├── edgeDetection.js
│   ├── vectorization.js
│   ├── lineSolver.js
│   ├── svgExport.js
│   └── ...
├── models/
│   └── u2netp.onnx     # U2-Netp セグメンテーションモデル
├── serve.py            # 開発サーバー
└── README.md          # このファイル
```

## 制作

**針金細工 八百魚（WIRE WORK YAOUO）**  
https://yaouo.jp

---

*Photo2wireはブラウザ技術とAIを活用した、針金細工創作支援ツールです。*
