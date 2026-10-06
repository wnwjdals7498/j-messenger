package com.jmessenger.android;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.widget.FrameLayout;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.Locale;
import java.util.regex.Pattern;

public final class MainActivity extends ComponentActivity {
    private static final String VM_HOST = "10.77.0.10";
    private static final String APP_URL = "https://10.77.0.10/_app/index.html";
    private static final int FILE_PICKER_REQUEST = 4102;
    private static final int DOWNLOAD_SAVE_REQUEST = 4103;
    private static final String DOWNLOAD_BRIDGE_NAME = "JMessengerAndroidDownloads";
    private static final long MAX_UPLOAD_BYTES = 5_000_000L;
    private static final int MAX_DOWNLOAD_BYTES = 5_000_000;
    private static final int MAX_DOWNLOAD_BASE64_CHARS = 6_666_668;
    private static final int MAX_DOWNLOAD_MESSAGE_CHARS = MAX_DOWNLOAD_BASE64_CHARS + 4096;
    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final Pattern MIME_PATTERN = Pattern.compile(
            "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$");
    private static final Pattern BASE64_PATTERN = Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private WebViewAssetLoader assetLoader;
    private PendingDownload pendingDownload;
    private ExecutorService downloadExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        webView = new WebView(this);
        webView.setId(R.id.web_view);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(android.graphics.Color.rgb(243, 246, 251));
        container.addView(webView);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            FrameLayout.LayoutParams bounds = (FrameLayout.LayoutParams) webView.getLayoutParams();
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                bounds.setMargins(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            } else {
                bounds.setMargins(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            webView.setLayoutParams(bounds);
            return insets;
        });
        setContentView(container);
        container.requestApplyInsets();
        downloadExecutor = Executors.newSingleThreadExecutor();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (webView == null) { finish(); return; }
                webView.evaluateJavascript("(() => { const active=document.activeElement; const editing=active && (active.isContentEditable || active.tagName==='TEXTAREA' || (active.tagName==='INPUT' && ['text','password','email','search','url','tel','number'].includes(active.type))); if(editing){active.blur();return 'input';} const back=document.querySelector('button[aria-label=\"대화 목록으로\"]'); if(back){back.click();return 'list';}return 'history';})()", handled -> {
                    if ("\"input\"".equals(handled)) {
                        if (webView != null) {
                            InputMethodManager ime = (InputMethodManager) getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                            if (ime != null) ime.hideSoftInputFromWindow(webView.getWindowToken(), 0);
                            webView.clearFocus();
                        }
                        return;
                    }
                    if ("\"list\"".equals(handled)) return;
                    if (webView != null && webView.canGoBack()) webView.goBack();
                    else finish();
                });
            }
        });

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(VM_HOST)
                .addPathHandler("/_app/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new VmWebViewClient());
        installDownloadBridge();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                cancelPendingFileRequest();
                pendingFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(intent, FILE_PICKER_REQUEST);
                    return true;
                } catch (RuntimeException unavailable) {
                    cancelPendingFileRequest();
                    Toast.makeText(MainActivity.this, "파일 선택기를 열 수 없습니다.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
        // Keep the fallback explicit if this WebView routes a download outside the scoped bridge.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                Toast.makeText(this, "첨부 파일을 저장할 수 없습니다.", Toast.LENGTH_SHORT).show());

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(APP_URL);
        }
    }

    private void installDownloadBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, DOWNLOAD_BRIDGE_NAME,
                java.util.Collections.singleton("https://10.77.0.10"),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || !isVmOrigin(sourceOrigin)) {
                        postReply(replyProxy, "", false, "unavailable");
                        return;
                    }
                    String data = message.getData();
                    if (data == null || data.length() > MAX_DOWNLOAD_MESSAGE_CHARS) {
                        postReply(replyProxy, "", false, "too_large");
                        showDownloadError("too_large");
                        return;
                    }
                    runOnUiThread(() -> acceptDownloadMessage(data, replyProxy));
                });
    }

    private void acceptDownloadMessage(String data, JavaScriptReplyProxy replyProxy) {
        JSONObject request;
        String id = "";
        try {
            request = new JSONObject(data);
            String candidateId = request.optString("id", "");
            if (UUID_PATTERN.matcher(candidateId).matches()) id = candidateId;

            String filename = request.optString("filename", "");
            String mime = request.optString("mime", "");
            String encoded = request.optString("base64", "");
            if (id.isEmpty() || filename.length() > 256 || encoded.isEmpty()
                    || encoded.length() > MAX_DOWNLOAD_BASE64_CHARS
                    || encoded.length() % 4 != 0
                    || !BASE64_PATTERN.matcher(encoded).matches()) {
                rejectDownload(replyProxy, id, "invalid_request");
                return;
            }

            long decodedLength = decodedLength(encoded);
            if (decodedLength < 1 || decodedLength > MAX_DOWNLOAD_BYTES) {
                rejectDownload(replyProxy, id, "too_large");
                return;
            }
            if (pendingDownload != null) {
                rejectDownload(replyProxy, id, "busy");
                return;
            }

            PendingDownload pending = new PendingDownload(id, safeFilename(filename), safeMime(mime),
                    (int) decodedLength, replyProxy);
            pendingDownload = pending;
            String base64 = encoded;
            try {
                downloadExecutor.execute(() -> decodeIntoPrivateCache(pending, base64));
            } catch (RuntimeException unavailable) {
                finishDownload(pending, false, "unavailable", true);
            }
        } catch (JSONException | RuntimeException invalid) {
            rejectDownload(replyProxy, id, "invalid_request");
        }
    }

    private void decodeIntoPrivateCache(PendingDownload pending, String encoded) {
        File tempFile = null;
        try {
            byte[] bytes = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
            if (bytes.length < 1 || bytes.length > MAX_DOWNLOAD_BYTES || bytes.length != pending.expectedBytes) {
                throw new IOException("invalid size");
            }
            tempFile = File.createTempFile("jmsg-download-", ".tmp", getCacheDir());
            pending.tempFile = tempFile;
            try (FileOutputStream output = new FileOutputStream(tempFile)) {
                output.write(bytes);
                output.getFD().sync();
            }
            if (pending.cancelled) {
                deleteOwnedTempFile(pending);
                return;
            }
            mainHandler.post(() -> showSaveDestination(pending));
        } catch (RuntimeException | IOException invalid) {
            deletePrivateDownloadFile(tempFile);
            mainHandler.post(() -> finishDownload(pending, false, "read_failed", true));
        }
    }

    private void showSaveDestination(PendingDownload pending) {
        if (pendingDownload != pending || pending.cancelled || isFinishing() || isDestroyed()) {
            finishDownload(pending, false, "unavailable", false);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(pending.mime);
        intent.putExtra(Intent.EXTRA_TITLE, pending.filename);
        try {
            startActivityForResult(intent, DOWNLOAD_SAVE_REQUEST);
        } catch (RuntimeException unavailable) {
            finishDownload(pending, false, "unavailable", true);
        }
    }

    private void savePendingDownload(int resultCode, Intent data) {
        PendingDownload pending = pendingDownload;
        if (pending == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            finishDownload(pending, false, "cancelled", false);
            return;
        }

        try {
            Uri destination = data.getData();
            if (!"content".equals(destination.getScheme())) throw new IOException("invalid destination");
            downloadExecutor.execute(() -> copyPendingDownload(pending, destination));
        } catch (IOException | RuntimeException failure) {
            finishDownload(pending, false, "save_failed", true);
        }
    }

    private void copyPendingDownload(PendingDownload pending, Uri destination) {
        try {
            long written = 0;
            try (OutputStream destinationStream = getContentResolver().openOutputStream(destination, "w");
                    InputStream input = new FileInputStream(pending.tempFile)) {
                if (destinationStream == null) throw new IOException("destination unavailable");
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (pending.cancelled) throw new IOException("cancelled");
                    written += read;
                    if (written > MAX_DOWNLOAD_BYTES || written > pending.expectedBytes) {
                        throw new IOException("invalid size");
                    }
                    destinationStream.write(buffer, 0, read);
                }
            }
            if (written != pending.expectedBytes) throw new IOException("incomplete file");
            mainHandler.post(() -> finishDownload(pending, true, null, false));
        } catch (IOException | RuntimeException failure) {
            mainHandler.post(() -> finishDownload(pending, false, "save_failed", true));
        }
    }

    private void finishDownload(PendingDownload pending, boolean saved, String error, boolean showError) {
        if (pendingDownload != pending) {
            deleteOwnedTempFile(pending);
            return;
        }
        pendingDownload = null;
        pending.cancelled = true;
        deleteOwnedTempFile(pending);
        postReply(pending.replyProxy, pending.id, saved, error);
        if (saved) Toast.makeText(this, "첨부 파일을 저장했습니다.", Toast.LENGTH_SHORT).show();
        else if (showError) showDownloadError(error);
    }

    private void cancelPendingDownload(String error) {
        PendingDownload pending = pendingDownload;
        if (pending == null) return;
        pending.cancelled = true;
        pendingDownload = null;
        deleteOwnedTempFile(pending);
        postReply(pending.replyProxy, pending.id, false, error);
    }

    private void rejectDownload(JavaScriptReplyProxy replyProxy, String id, String error) {
        postReply(replyProxy, id, false, error);
        if ("busy".equals(error) || "unavailable".equals(error) || "too_large".equals(error)) {
            showDownloadError(error);
        }
    }

    private void showDownloadError(String error) {
        String message;
        if ("busy".equals(error)) message = "다른 파일을 저장하고 있습니다.";
        else if ("too_large".equals(error)) message = "5MB 이하의 파일만 저장할 수 있습니다.";
        else if ("save_failed".equals(error)) message = "저장 권한을 확인하고 다시 시도해 주세요.";
        else if ("read_failed".equals(error)) message = "파일을 읽지 못했습니다.";
        else if ("unsupported".equals(error)) message = "이 Android WebView에서는 파일 저장을 지원하지 않습니다.";
        else message = "파일을 저장할 수 없습니다.";
        mainHandler.post(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    private static long decodedLength(String encoded) {
        int padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        return (long) (encoded.length() / 4) * 3 - padding;
    }

    private static String safeFilename(String input) {
        StringBuilder safe = new StringBuilder(Math.min(input.length(), 128));
        for (int index = 0; index < input.length() && safe.length() < 128; index++) {
            char character = input.charAt(index);
            if (character == '/' || character == '\\' || Character.isISOControl(character)) continue;
            safe.append(character);
        }
        String filename = safe.toString().trim();
        return filename.isEmpty() || ".".equals(filename) || "..".equals(filename)
                ? "attachment" : filename;
    }

    private static String safeMime(String input) {
        return input != null && MIME_PATTERN.matcher(input).matches()
                ? input : "application/octet-stream";
    }

    private static boolean isVmOrigin(Uri origin) {
        return origin != null && "https".equalsIgnoreCase(origin.getScheme())
                && VM_HOST.equalsIgnoreCase(origin.getHost())
                && (origin.getPort() == -1 || origin.getPort() == 443)
                && (origin.getPath() == null || origin.getPath().isEmpty());
    }

    private static void postReply(JavaScriptReplyProxy proxy, String id, boolean saved, String error) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        JSONObject response = new JSONObject();
        try {
            response.put("id", id == null ? "" : id);
            response.put("saved", saved);
            if (error != null) response.put("error", error);
        } catch (JSONException ignored) {
            return;
        }
        try {
            proxy.postMessage(response.toString());
        } catch (RuntimeException detached) {
            // The page may have navigated away while its request was being completed.
        }
    }

    private void deleteOwnedTempFile(PendingDownload pending) {
        File file = pending.tempFile;
        pending.tempFile = null;
        deletePrivateDownloadFile(file);
    }

    private void deletePrivateDownloadFile(File file) {
        if (file != null && file.getParentFile() != null
                && file.getParentFile().equals(getCacheDir())
                && file.getName().startsWith("jmsg-download-") && file.isFile()) {
            // The prefix is generated by this Activity's private-cache temp-file path.
            file.delete();
        }
    }

    private static final class PendingDownload {
        final String id;
        final String filename;
        final String mime;
        final int expectedBytes;
        final JavaScriptReplyProxy replyProxy;
        volatile File tempFile;
        volatile boolean cancelled;

        PendingDownload(String id, String filename, String mime, int expectedBytes,
                JavaScriptReplyProxy replyProxy) {
            this.id = id;
            this.filename = filename;
            this.mime = mime;
            this.expectedBytes = expectedBytes;
            this.replyProxy = replyProxy;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DOWNLOAD_SAVE_REQUEST) {
            savePendingDownload(resultCode, data);
            return;
        }
        if (requestCode != FILE_PICKER_REQUEST || pendingFileCallback == null) return;

        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri selected = data.getData();
            try {
                if (isAllowedUpload(selected)) result = new Uri[]{selected};
                else Toast.makeText(this, "5MB 이하의 지원 파일만 선택할 수 있습니다.", Toast.LENGTH_SHORT).show();
            } catch (IOException | RuntimeException ignored) {
                Toast.makeText(this, "선택한 파일을 읽을 수 없습니다.", Toast.LENGTH_SHORT).show();
            }
        }

        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        callback.onReceiveValue(result);
    }

    private boolean isAllowedUpload(Uri uri) throws IOException {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) return false;
        String name = queryDisplayName(uri);
        if (name == null) return false;
        String lowerName = name.toLowerCase(Locale.ROOT);
        String[] extensions = {".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt", ".csv", ".docx", ".xlsx", ".zip"};
        boolean supported = false;
        for (String extension : extensions) {
            if (lowerName.endsWith(extension)) {
                supported = true;
                break;
            }
        }
        if (!supported) return false;

        ContentResolver resolver = getContentResolver();
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) return false;
            byte[] buffer = new byte[8192];
            long total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_UPLOAD_BYTES) return false;
            }
            return true;
        }
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (RuntimeException ignored) {
            return null;
        }
        return null;
    }

    private void cancelPendingFileRequest() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        cancelPendingFileRequest();
        cancelPendingDownload("unavailable");
        if (downloadExecutor != null) downloadExecutor.shutdownNow();
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static boolean isVmHttps(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
                && VM_HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private final class VmWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !isVmHttps(request.getUrl());
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isVmHttps(uri)) {
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, null);
            }
            WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
            if (local != null) return local;
            if (uri.getPath() != null && uri.getPath().startsWith("/_app/")) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
            }
            return null;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler,
                android.net.http.SslError error) {
            handler.cancel();
        }

        @Override
        public boolean onRenderProcessGone(WebView view,
                android.webkit.RenderProcessGoneDetail detail) {
            cancelPendingFileRequest();
            cancelPendingDownload("unavailable");
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.setWebChromeClient(null);
            view.setWebViewClient(null);
            view.destroy();
            webView = null;
            Toast.makeText(MainActivity.this, "앱 화면을 다시 불러옵니다.", Toast.LENGTH_SHORT).show();
            recreate();
            return true;
        }
    }
}
