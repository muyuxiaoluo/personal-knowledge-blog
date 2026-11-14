package FIXTURE_PACKAGE;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Bundle;

/** Emulator-only sender, never distributed with the workbench. No networking or account access. */
public class MainActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    send();
  }
  @Override public void onNewIntent(android.content.Intent intent) {
    super.onNewIntent(intent); setIntent(intent); send();
  }
  private void send() {
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(new NotificationChannel("fixture", "Test finance messages", NotificationManager.IMPORTANCE_DEFAULT));
    String title = getIntent().getStringExtra("title");
    String body = getIntent().getStringExtra("body");
    manager.notify(getIntent().getIntExtra("id", 1), new Notification.Builder(this, "fixture")
      .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(body)
      .setWhen(getIntent().getLongExtra("when", System.currentTimeMillis())).build());
    finish();
  }
}
