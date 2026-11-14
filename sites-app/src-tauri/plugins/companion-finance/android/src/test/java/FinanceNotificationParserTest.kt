package com.muyuxiaoluo.companionfinance

import org.junit.Assert.*
import org.junit.Test

class FinanceNotificationParserTest {
    @Test fun readsReportedWechatPaidNotificationAsExpense() {
        for (body in listOf("已支付 1.00", "已支付 ¥1.00", "已支付 ￥ 1.00", "已支付 1.00元", "已支付 金额：1.00元")) {
            val parsed = FinanceNotificationParser.parse("com.tencent.mm", "微信支付", body)
            assertEquals(body, 100L, parsed?.amount)
            assertEquals(body, "expense", parsed?.kind)
        }
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "同学", "已支付 ¥1.00"))
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "已支付 ¥1.00，交易失败"))
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "已支付 ¥1.00、已支付 ¥2.00"))
        assertEquals("refund", FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "已支付订单退款到账 ¥1.00")?.kind)
    }
    @Test fun readsAmountsAndRejectsOrdinaryChats() {
        assertEquals(2180L, FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "¥21.80")?.amount)
        assertEquals(2180L, FinanceNotificationParser.parse("cmb.pb", "招商银行", "¥21.80")?.amount)
        assertEquals("unknown", FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "¥21.80")?.kind)
        assertEquals("expense", FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "支付成功，金额21.80元")?.kind)
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "同学", "微信支付 ¥21.80"))
        assertNull(FinanceNotificationParser.parse("other.app", "微信支付", "¥21.80"))
        assertNull(FinanceNotificationParser.parse("cmb.pb", "消费通知", "消费10.00美元"))
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "支付失败 ¥21.80"))
    }
    @Test fun distinguishesBalanceAndTransferRefunds() {
        assertEquals(360L, FinanceNotificationParser.parse("cmb.pb", "消费通知", "消费3.60元，余额1000.00元")?.amount)
        assertEquals("refund", FinanceNotificationParser.parse("cmb.pb", "交易提醒", "退款到账 ¥10.00")?.kind)
        assertEquals("transfer", FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "零钱充值 ¥100.00")?.kind)
        assertNull(FinanceNotificationParser.parse("cmb.pb", "优惠券", "支付 ¥10.00"))
        assertNull(FinanceNotificationParser.parse("com.tencent.mm", "微信支付", "¥10.00、¥20.00"))
        assertEquals(123456L, FinanceNotificationParser.parse("cmb.pb", "交易通知", "支出1,234.56元")?.amount)
    }
}
