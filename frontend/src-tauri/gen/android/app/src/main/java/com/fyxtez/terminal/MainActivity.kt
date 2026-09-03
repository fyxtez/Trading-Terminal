package com.fyxtez.terminal

import android.graphics.Color
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    System.loadLibrary("fyxtez_terminal_desktop_lib")
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<android.view.View>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(11, 14, 20))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val safeInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(
        safeInsets.left,
        safeInsets.top,
        safeInsets.right,
        maxOf(safeInsets.bottom, imeInsets.bottom),
      )
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
