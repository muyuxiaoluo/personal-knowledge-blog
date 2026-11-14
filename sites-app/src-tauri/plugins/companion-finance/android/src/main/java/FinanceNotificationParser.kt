package com.muyuxiaoluo.companionfinance

import java.math.BigDecimal

data class ParsedFinance(val source: String, val amount: Long, val kind: String)

/** Strict source selection; ordinary chats, balance-only and ambiguous amounts are discarded. */
object FinanceNotificationParser {
    private val namedAmount = Regex("(?:消费|支出|扣款|付款|支付|交易金额|退款|收入|到账)(?:成功|金额|人民币)?\\s*[:：]?\\s*[¥￥]?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?![0-9.])")
    private val currencyAmount = Regex("(?:[¥￥]|人民币\\s*)([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?![0-9.])|([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?![0-9.])\\s*元")
    fun parse(pkg: String, title: String, body: String): ParsedFinance? {
        val source = when {
            pkg == "cmb.pb" -> "cmb"
            pkg == "com.tencent.mm" && Regex("^(?:\\[\\d+条\\])?微信支付(?:[:：\\s]|$)").containsMatchIn(title.trim()) -> "wechat"
            else -> return null
        }
        val text = "$title $body"
        if (Regex("美元|港币|欧元|英镑|日元|USD|HKD|EUR|GBP|JPY", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null
        if (text.length > 8000 || Regex("验证码|登录验证|营销|优惠券|年化|可用额度").containsMatchIn(text)) return null
        if (source == "cmb" && Regex("余额").containsMatchIn(text) && !Regex("消费|支出|扣款|付款|支付|交易|退款|收入|到账|充值|提现|转账|转出|转入").containsMatchIn(text)) return null
        val named = namedAmount.findAll(body).map { it.groupValues[1] }.toList()
        val values = if (named.isNotEmpty()) named else currencyAmount.findAll(text).map { it.groupValues[1].ifEmpty { it.groupValues[2] } }.toList()
        val amounts = values.mapNotNull { value -> try { BigDecimal(value.replace(",", "")).movePointRight(2).longValueExact() } catch (_: Exception) { null } }.distinct()
        val amount = amounts.singleOrNull()?.takeIf { it in 1..100_000_000_000L } ?: return null
        val kind = when {
            Regex("退款|退货|退回").containsMatchIn(text) -> "refund"
            Regex("充值|提现|转账|转出|转入").containsMatchIn(text) -> "transfer"
            Regex("收入|收款|到账").containsMatchIn(text) -> "income"
            Regex("已支付|支付成功|付款成功|扣款成功|消费|支出|使用零钱支付|通过零钱扣款").containsMatchIn(text) -> "expense"
            else -> "unknown"
        }
        if (Regex("失败|未成功|取消|待支付|待付款").containsMatchIn(text)) return null
        return ParsedFinance(source, amount, kind)
    }
}
