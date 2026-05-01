#!/usr/bin/env bash
# クライアント側インターフェース。ip addr で見えた eth0 を使う
IF="${IF:-eth0}"
# ingress を制限するための IFB デバイス
IFB="${IFB:-ifb0}"

ensure_ifb() {
  # IFB デバイスを作成して up にする（既に存在する場合は何もしない）
  ip link show "$IFB" >/dev/null 2>&1 || ip link add "$IFB" type ifb || return 1
  ip link set dev "$IFB" up
}

tc_clear() {
  # eth0 に付いている遅延/帯域制限の設定をすべて削除して初期状態に戻す
  tc qdisc del dev "$IF" root 2>/dev/null || true
  tc qdisc del dev "$IF" ingress 2>/dev/null || true
  tc qdisc del dev "$IFB" root 2>/dev/null || true
}

tc_apply_profile() {
  local rate="$1"   # 例: 100mbit
  local delay="$2"  # 例: 20ms
  tc_clear
  ensure_ifb
  # 上り（egress）: htb で帯域、netem で遅延
  tc qdisc add dev "$IF" root handle 1: htb default 1
  tc class add dev "$IF" parent 1: classid 1:1 htb rate "$rate" ceil "$rate"
  tc qdisc add dev "$IF" parent 1:1 handle 10: netem delay "$delay"
  # 下り（ingress）は IF -> IFB に転送して IFB 側で制御
  tc qdisc add dev "$IF" ingress
  tc filter add dev "$IF" parent ffff: protocol all u32 match u32 0 0 action mirred egress redirect dev "$IFB"
  tc qdisc add dev "$IFB" root handle 2: htb default 1
  tc class add dev "$IFB" parent 2: classid 2:1 htb rate "$rate" ceil "$rate"
  tc qdisc add dev "$IFB" parent 2:1 handle 20: netem delay "$delay"
}

tc_fast4g() {
  # Fast 4G:
  # download ≒ 100Mbps, latency ≒ 20ms を再現
  tc_apply_profile 100mbit 20ms
}

tc_regular4g() {
  # Regular 4G:
  # download ≒ 30Mbps, latency ≒ 20ms を再現
  tc_apply_profile 30mbit 20ms
}

tc_fast3g() {
  # Fast 3G:
  # download ≒ 1.5Mbps, latency ≒ 20ms を再現
  tc_apply_profile 1.5mbit 20ms
}

tc_slow3g() {
  # Slow 3G:
  # download ≒ 0.4Mbps(400kbps), latency ≒ 20ms を再現
  tc_apply_profile 400kbit 20ms
}

tc_show() {
  # 現在 eth0 にどんな遅延/帯域制限が掛かっているか確認する
  echo "=== Uplink (egress) on $IF ==="
  tc qdisc show dev "$IF"
  tc class show dev "$IF"
  echo "=== Downlink (ingress via $IFB) ==="
  tc qdisc show dev "$IFB"
  tc class show dev "$IFB"
}

case "$1" in
  clear)     tc_clear ;;
  fast4g)    tc_fast4g ;;
  regular4g) tc_regular4g ;;
  fast3g)    tc_fast3g ;;
  slow3g)    tc_slow3g ;;
  show)      tc_show ;;
  "" ) ;;  # 引数なしのときは何もしない
  * )
    echo "usage: $0 {clear|fast4g|regular4g|fast3g|slow3g|show}" >&2
    exit 1
    ;;
esac
