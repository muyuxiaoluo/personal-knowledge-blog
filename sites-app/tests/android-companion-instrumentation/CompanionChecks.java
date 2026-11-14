package com.muyuxiaoluo.workbenchchecks;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONTokener;

/** Test-only, same-signature instrumentation for the actual optimized APK; not shipped. */
public class CompanionChecks extends Instrumentation {
    private String script;
    private boolean checkNotifications;
    private boolean unbindListener;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        script = new String(Base64.decode(arguments.getString("script"), Base64.DEFAULT), StandardCharsets.UTF_8);
        checkNotifications = "true".equals(arguments.getString("checkNotifications"));
        unbindListener = "true".equals(arguments.getString("unbindListener"));
        start();
    }
    private WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }
    @Override public void onStart() {
        Bundle output = new Bundle();
        try {
            Intent intent = new Intent(Intent.ACTION_MAIN);
            intent.setClassName(getTargetContext().getPackageName(), "com.muyuxiaoluo.workbench.MainActivity");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = startActivitySync(intent);
            final WebView[] web = new WebView[1];
            for (int i = 0; i < 100 && web[0] == null; i++) {
                runOnMainSync(() -> web[0] = findWebView(activity.getWindow().getDecorView()));
                if (web[0] == null) Thread.sleep(200);
            }
            if (web[0] == null) throw new IllegalStateException("Native WebView unavailable");
            final boolean[] loaded = new boolean[1];
            for (int i = 0; i < 100 && !loaded[0]; i++) {
                runOnMainSync(() -> loaded[0] = "https://tauri.localhost/".equals(web[0].getUrl()) && web[0].getProgress() == 100);
                if (!loaded[0]) Thread.sleep(200);
            }
            if (!loaded[0]) throw new IllegalStateException("Native page did not load");
            if (unbindListener) {
                // Wait for startup initialization before simulating a later
                // system unbind, otherwise startup itself masks the recovery.
                final boolean[] ready = new boolean[1];
                for (int i = 0; i < 100 && !ready[0]; i++) {
                    CountDownLatch evaluated = new CountDownLatch(1);
                    runOnMainSync(() -> web[0].evaluateJavascript("!!document.querySelector('.account-entry')", text -> { ready[0] = "true".equals(text); evaluated.countDown(); }));
                    if (!evaluated.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("Home evaluation stalled");
                    if (!ready[0]) Thread.sleep(100);
                }
                if (!ready[0]) throw new IllegalStateException("Home did not initialize before unbind");
                if (android.os.Build.VERSION.SDK_INT < 34) throw new IllegalStateException("Unbind fixture requires API 34+");
                android.content.ComponentName component = new android.content.ComponentName(getTargetContext().getPackageName(), "com.muyuxiaoluo.companionfinance.FinanceListener");
                runOnMainSync(() -> android.service.notification.NotificationListenerService.requestUnbind(component));
                Thread.sleep(1000);
                if (!getTargetContext().getSystemService(NotificationManager.class).isNotificationListenerAccessGranted(component))
                    throw new IllegalStateException("Unbind fixture unexpectedly revoked access");
            }
            String expression = "(async()=>{"
                + "for(let i=0;i<100&&!document.querySelector('.account-entry');i++)await new Promise(r=>setTimeout(r,200));"
                + "if(!document.querySelector('.account-entry'))throw new Error('Companion home did not initialize');"
                + script + "})().then(value=>window.__buildCheckResult=JSON.stringify({ok:true,value}),"
                + "error=>window.__buildCheckResult=JSON.stringify({ok:false,error:String(error)}))";
            runOnMainSync(() -> web[0].evaluateJavascript(expression, null));
            String result = null;
            for (int i = 0; i < 375 && result == null; i++) {
                final String[] value = new String[1];
                CountDownLatch evaluated = new CountDownLatch(1);
                runOnMainSync(() -> web[0].evaluateJavascript("window.__buildCheckResult || null", text -> { value[0] = text; evaluated.countDown(); }));
                if (!evaluated.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("WebView evaluation stalled");
                if (value[0] != null && !"null".equals(value[0])) result = (String) new JSONTokener(value[0]).nextValue();
                if (result == null) Thread.sleep(200);
            }
            if (result == null) throw new IllegalStateException("Native page test timed out");
            if (checkNotifications && new org.json.JSONObject(result).optBoolean("ok")) {
                NotificationManager manager = getTargetContext().getSystemService(NotificationManager.class);
                boolean instant = false, test = false;
                for (android.service.notification.StatusBarNotification item : manager.getActiveNotifications()) {
                    if (item.getId() != 41001 && item.getId() != 41004) continue;
                    if ((item.getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0)
                        throw new IllegalStateException("A new-transaction reminder still suppresses subsequent alerts");
                    if (item.getId() == 41001) instant = true;
                    if (item.getId() == 41004) test = true;
                }
                if (!instant || !test) throw new IllegalStateException("Expected both transaction and test reminders");
                if (manager.getNotificationChannel("finance_capture").getImportance() == NotificationManager.IMPORTANCE_NONE)
                    throw new IllegalStateException("Test channel is blocked");
            }
            output.putString("resultBase64", Base64.encodeToString(result.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            finish(Activity.RESULT_OK, output);
        } catch (Throwable error) {
            output.putString("failure", error.getClass().getSimpleName() + ": " + error.getMessage());
            finish(Activity.RESULT_CANCELED, output);
        }
    }
}
