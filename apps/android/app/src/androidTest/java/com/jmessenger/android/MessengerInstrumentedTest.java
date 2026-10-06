package com.jmessenger.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.os.ParcelFileDescriptor;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.lifecycle.Lifecycle;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.Before;
import org.junit.After;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

@RunWith(AndroidJUnit4.class)
public final class MessengerInstrumentedTest {
    private static final String VM_BASE = "https://10.77.0.10";
    private static final String SERVER_ID = "dev-a";
    private static final String PASSWORD = "dev-only";
    private static final String FIXTURE_NAME = "jmessenger-android-fixture.txt";
    private static final String FIXTURE_PATH = "/sdcard/Download/" + FIXTURE_NAME;
    private static long previousCaseCompletedAt;

    @Before
    public void paceFunctionalCasesWithinTheVmRequestPolicy() throws InterruptedException {
        // Each case restores the retained lab conversations. This suite tests behavior,
        // not bursts beyond the unchanged VM policy of 100 requests per minute.
        if (previousCaseCompletedAt == 0) return;
        long readyAt = previousCaseCompletedAt + 65_000L;
        while (android.os.SystemClock.elapsedRealtime() < readyAt) {
            Thread.sleep(Math.min(1_000L, readyAt - android.os.SystemClock.elapsedRealtime()));
        }
    }

    @After
    public void recordFunctionalCaseCompletion() {
        previousCaseCompletedAt = android.os.SystemClock.elapsedRealtime();
    }

    @Test
    public void filePickerUploadAndNativeDownloadPreserveFixtureBytes() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String groupTitle = "Android files " + suffix;
        String messageText = "Android fixture transfer " + suffix;
        String savedName = "jmessenger-saved-" + suffix + ".txt";
        byte[] fixtureBytes = readSharedFile(FIXTURE_PATH);
        assertTrue("Root must seed a non-empty public device fixture", fixtureBytes.length > 0);

        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        try {
            dismissSystemUiAnrIfPresent();
            ensureAliceLoggedIn(scenario);
            click(scenario, "button[aria-label='새 대화 만들기']");
            waitFor(scenario, "document.querySelector('.create-form select[aria-label=\\\"참여자\\\"] option') !== null");
            createGroupWithBob(scenario, groupTitle);
            waitFor(scenario, "document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle));

            UiObject2 attachButton = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .wait(Until.findObject(By.desc("파일 첨부")), 10_000L);
            assertNotNull("The Android file attachment control must be visible", attachButton);
            attachButton.click();
            selectFixtureFromDocumentPicker();
            waitFor(scenario, "Array.from(document.querySelectorAll('.attachment-staging li')).some(li => li.textContent.includes(" + JSONObject.quote(FIXTURE_NAME) + "))");
            captureScreenshot(scenario, "file-staged.png", FIXTURE_NAME);

            setComposerAndSend(scenario, messageText);
            waitFor(scenario, "Array.from(document.querySelectorAll('.message-row')).some(row => row.textContent.includes(" + JSONObject.quote(messageText) + ") && row.querySelector('button.file-download'))");
            captureScreenshot(scenario, "file-uploaded.png", messageText);

            VmSession bob = loginBob();
            JSONObject conversation = findConversation(bob, groupTitle);
            assertNotNull("Bob's session must see the group created in the Android UI", conversation);
            String conversationId = conversation.getString("id");
            JSONObject uploadedMessage = findMessage(bob, conversationId, messageText);
            assertNotNull("Bob's HTTPS history must contain the Android file message", uploadedMessage);
            JSONArray fileIds = uploadedMessage.getJSONArray("fileIds");
            assertEquals("The uploaded fixture must be attached exactly once", 1, fileIds.length());
            String fileId = fileIds.getString(0);
            byte[] serverBytes = downloadFileBytes(bob, fileId);
            assertTrue("Bob's authenticated download must match the selected fixture bytes",
                    MessageDigest.isEqual(fixtureBytes, serverBytes));

            installDownloadAckObserver(scenario);
            UiObject2 downloadButton = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .wait(Until.findObject(By.textContains("첨부 파일 다운로드")), 10_000L);
            assertNotNull("The uploaded attachment must expose its download control", downloadButton);
            downloadButton.click();
            saveNativeDownloadToDownloads(savedName);
            // The save toast is transient and UiAutomator can miss it; the bridge acknowledgement follows the completed SAF byte copy.
            JSONObject ack = waitForDownloadAck(scenario);
            assertTrue("The native download response must carry a request id",
                    ack.optString("id").matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
            assertTrue("The native download response must confirm the save", ack.optBoolean("saved"));
            assertFalse("A completed native save must not include an error", ack.has("error") && !ack.isNull("error") && !ack.optString("error").isEmpty());
            byte[] savedBytes = waitForSharedFile("/sdcard/Download/" + savedName, fixtureBytes);
            assertTrue("The saved SAF document must match the original fixture byte for byte",
                    MessageDigest.isEqual(fixtureBytes, savedBytes));
            captureScreenshot(scenario, "file-downloaded.png", messageText);

            click(scenario, "button[aria-label='로그아웃']");
            waitFor(scenario, "document.querySelector('.login-page h1')?.textContent.trim() === 'J 메신저'");
        } finally {
            scenario.close();
        }
    }

    @Test
    public void webAppMessagingSessionRestoreAndLogoutOnDevice() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String groupTitle = "Android lab " + suffix;
        String aliceText = "Alice device message " + suffix;
        String bobText = "Bob live reply " + suffix;
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        try {
            dismissSystemUiAnrIfPresent();
            ensureAliceLoggedIn(scenario);
            captureScreenshot(scenario, "alice-signed-in.png", "Alice");

            click(scenario, "button[aria-label='새 대화 만들기']");
            waitFor(scenario, "document.querySelector('.create-form select[aria-label=\\\"참여자\\\"] option') !== null");
            createGroupWithBob(scenario, groupTitle);
            waitFor(scenario, "document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle));

            setComposerAndSend(scenario, aliceText);
            waitFor(scenario, "Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(aliceText) + ")");

            VmSession bob = loginBob();
            JSONObject conversation = findConversation(bob, groupTitle);
            assertNotNull("Bob's session must see the group created in the Android UI", conversation);
            String conversationId = conversation.getString("id");
            String bobId = bob.user.getString("id");
            assertTrue("Bob must be a member of the created group", containsString(conversation.getJSONArray("memberIds"), bobId));
            assertTrue("Bob's HTTPS message history must include Alice's UI message", hasMessage(bob, conversationId, aliceText));

            postMessage(bob, conversationId, bobText);
            waitFor(scenario, "Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(bobText) + ")");
            assertTrue("Bob's WebSocket reply must appear in the active Android WebView", hasIncomingMessage(scenario, bobText));
            captureScreenshot(scenario, "two-user-live-message.png", bobText);

            scenario.recreate();
            waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice'");
            waitFor(scenario, "Array.from(document.querySelectorAll('button.conversation-item')).some(b=>b.textContent.includes(" + JSONObject.quote(groupTitle) + "))");
            clickConversation(scenario, groupTitle);
            waitFor(scenario, "document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle));
            waitFor(scenario, "Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(bobText) + ")");
            captureScreenshot(scenario, "restored-session.png", bobText);

            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            exerciseImeWithoutSending(scenario, bobText);
            device.pressBack();
            waitForImeVisibility(scenario, false, 10_000L);
            device.waitForIdle(5_000L);
            assertEquals("Dismissing the IME must leave the app resumed", Lifecycle.State.RESUMED, scenario.getState());
            waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice' && document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle) + " && Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(bobText) + ")");

            try {
                try {
                    device.setOrientationLeft();
                } catch (android.os.RemoteException failure) {
                    failWithScreenshot(scenario, "landscape-rotation-failure.png", "Rotation command failed; display=" + device.getDisplayWidth() + "x" + device.getDisplayHeight(), webComposerMetadata(scenario));
                }
                waitForLandscape(device, scenario, groupTitle, bobText);
                captureScreenshot(scenario, "landscape-session.png", bobText);
            } finally {
                try {
                    device.setOrientationNatural();
                } catch (android.os.RemoteException failure) {
                    failWithScreenshot(scenario, "natural-orientation-restore-failure.png", "Natural orientation restore command failed", webComposerMetadata(scenario));
                }
            }
            waitForPortrait(device, scenario);
            assertEquals("Returning to natural orientation must leave the app resumed", Lifecycle.State.RESUMED, scenario.getState());
            waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice' && document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle) + " && Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(bobText) + ")");

            device.pressBack();
            device.waitForIdle(5_000L);
            assertEquals("Android Back must keep the messenger activity active", Lifecycle.State.RESUMED, scenario.getState());
            waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice' && !document.querySelector('.chat-header') && Array.from(document.querySelectorAll('button.conversation-item')).some(b=>b.textContent.includes(" + JSONObject.quote(groupTitle) + "))");
            clickConversation(scenario, groupTitle);
            waitFor(scenario, "document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle));
            waitFor(scenario, "Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(bobText) + ")");
            assertEquals("Reopening after Android Back must keep the messenger activity active", Lifecycle.State.RESUMED, scenario.getState());

            click(scenario, "button[aria-label='로그아웃']");
            waitFor(scenario, "document.querySelector('.login-page h1')?.textContent.trim() === 'J 메신저'");
            assertFalse("Logout must clear the authenticated conversation view", evaluateBoolean(scenario,
                    "document.querySelector('.profile-card') !== null || document.querySelector('.message-bubble') !== null"));
        } finally {
            scenario.close();
        }
    }

    private static void setLoginAndSubmit(ActivityScenario<MainActivity> scenario, String username) throws Exception {
        String script = "(() => {"
                + "if(document.querySelector('.profile-card strong')?.textContent.trim()==='Alice')return 'restored';"
                + "const server=document.querySelector('.login-form select');"
                + "const serverSet=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;"
                + "serverSet.call(server,'dev-a'); server.dispatchEvent(new Event('change',{bubbles:true}));"
                + "const set=(el,value)=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};"
                + "set(document.querySelector('input[autocomplete=username]')," + JSONObject.quote(username) + ");"
                + "set(document.querySelector('input[autocomplete=current-password]')," + JSONObject.quote(PASSWORD) + ");"
                + "return 'ready'; })()";
        String prepared = evaluateString(scenario, script);
        assertTrue("Login inputs must be prepared or Alice's existing session restored",
                "ready".equals(prepared) || "restored".equals(prepared));
        // Startup session restoration can finish while the login form is being prepared.
        waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim()==='Alice' || (!!document.querySelector('.login-form button[type=submit]') && !document.querySelector('.login-form button[type=submit]').disabled)");
        String submitted = evaluateString(scenario, "(() => {if(document.querySelector('.profile-card strong')?.textContent.trim()==='Alice')return 'restored';const button=document.querySelector('.login-form button[type=submit]');if(!button||button.disabled)return 'not-ready';button.click();return 'submitted';})()");
        assertTrue("Login must be submitted or Alice's existing session restored",
                "submitted".equals(submitted) || "restored".equals(submitted));
    }

    private static void ensureAliceLoggedIn(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "document.querySelector('.login-form') !== null || document.querySelector('.profile-card strong') !== null");
        boolean hasProfile = evaluateBoolean(scenario, "document.querySelector('.profile-card strong') !== null");
        if (hasProfile && evaluateBoolean(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice'")) return;
        if (hasProfile) {
            click(scenario, "button[aria-label='로그아웃']");
            waitFor(scenario, "document.querySelector('.login-form') !== null");
        }
        setLoginAndSubmit(scenario, "alice");
        waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice'");
    }

    private static void createGroupWithBob(ActivityScenario<MainActivity> scenario, String title) throws Exception {
        String chooseGroup = "(() => {const radios=document.querySelectorAll('.create-form fieldset input[type=radio]');"
                + "if(radios.length!==2) return 'missing-kind-options'; radios[1].click(); return 'selected';})()";
        assertEquals("selected", evaluateString(scenario, chooseGroup));
        waitFor(scenario, "document.querySelector('.create-form input[placeholder=\\\"선택 사항\\\"]') !== null");
        waitFor(scenario, "Array.from(document.querySelectorAll('.create-form select[aria-label=\\\"참여자\\\"] option')).some(o=>o.textContent.trim()==='Bob')");

        String script = "(() => {"
                + "const title=document.querySelector('.create-form input[placeholder=\\\"선택 사항\\\"]');"
                + "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(title," + JSONObject.quote(title) + "); title.dispatchEvent(new Event('input',{bubbles:true}));"
                + "const people=document.querySelector('.create-form select[aria-label=\\\"참여자\\\"]');"
                + "const bob=Array.from(people.options).find(o=>o.textContent.trim()==='Bob'); if(!bob) return 'missing-bob';"
                + "bob.selected=true; people.dispatchEvent(new Event('change',{bubbles:true}));"
                + "return 'ready'; })()";
        assertEquals("ready", evaluateString(scenario, script));
        waitFor(scenario, "!document.querySelector('.create-form button[type=submit]').disabled");
        click(scenario, ".create-form button[type=submit]");
    }

    private static void setComposerAndSend(ActivityScenario<MainActivity> scenario, String message) throws Exception {
        String script = "(() => {const el=document.querySelector('textarea[aria-label=\\\"메시지 입력\\\"]');"
                + "const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el," + JSONObject.quote(message) + ");"
                + "el.dispatchEvent(new Event('input',{bubbles:true})); return 'ready';})()";
        assertEquals("ready", evaluateString(scenario, script));
        waitFor(scenario, "!document.querySelector('.composer button[type=submit]').disabled");
        click(scenario, ".composer button[type=submit]");
    }

    private static void clickConversation(ActivityScenario<MainActivity> scenario, String title) throws Exception {
        String script = "(() => {const item=Array.from(document.querySelectorAll('button.conversation-item')).find(b=>b.textContent.includes(" + JSONObject.quote(title) + "));"
                + "if(!item) return 'missing'; item.click(); return 'clicked';})()";
        assertEquals("clicked", evaluateString(scenario, script));
    }

    private static void click(ActivityScenario<MainActivity> scenario, String selector) throws Exception {
        String script = "(() => {const el=document.querySelector(" + JSONObject.quote(selector) + ");if(!el)return 'missing';el.click();return 'clicked';})()";
        assertEquals("clicked", evaluateString(scenario, script));
    }

    private static boolean hasIncomingMessage(ActivityScenario<MainActivity> scenario, String text) throws Exception {
        return evaluateBoolean(scenario, "Array.from(document.querySelectorAll('.message-row:not(.mine) .message-bubble p')).some(p=>p.textContent === " + JSONObject.quote(text) + ")");
    }

    private static void waitFor(ActivityScenario<MainActivity> scenario, String predicate) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (evaluateBoolean(scenario, predicate)) return;
            Thread.sleep(100);
        }
        String diagnostic;
        try {
            diagnostic = evaluateString(scenario,
                    "JSON.stringify({login:!!document.querySelector('.login-form'),profile:!!document.querySelector('.profile-card'),create:!!document.querySelector('.create-form'),readyState:document.readyState,error:document.querySelector('[role=alert]')?.textContent.trim()||''})");
        } catch (Exception unavailable) {
            diagnostic = "unavailable";
        }
        throw new AssertionError("Timed out waiting for app state; safe UI diagnostic=" + diagnostic);
    }

    private static String evaluateString(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        String raw = evaluateRaw(scenario, script);
        Object parsed = new JSONTokener(raw).nextValue();
        return parsed == null ? null : parsed.toString();
    }

    private static boolean evaluateBoolean(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        return "true".equals(evaluateRaw(scenario, script));
    }

    private static String evaluateRaw(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView webView = activity.findViewById(R.id.web_view);
            webView.evaluateJavascript(script, value -> {
                result.set(value);
                latch.countDown();
            });
        });
        assertTrue("WebView JavaScript evaluation must complete", latch.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private static void dismissSystemUiAnrIfPresent() {
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        UiObject2 systemDialog = device.wait(
                Until.findObject(By.text("System UI isn't responding")), 1_000L);
        if (systemDialog != null) {
            UiObject2 waitButton = device.findObject(By.text("Wait"));
            assertNotNull("System UI recovery must offer Wait", waitButton);
            waitButton.click();
            assertTrue("System UI recovery dialog must close after Wait",
                    device.wait(Until.gone(By.text("System UI isn't responding")), 10_000L));
        }
        assertTrue("No app-specific or persistent ANR dialog may cover the app",
                device.findObject(By.textContains("isn't responding")) == null);
    }

    private static void captureScreenshot(ActivityScenario<MainActivity> scenario, String fileName, String requiredVisibleText) throws Exception {
        dismissSystemUiAnrIfPresent();
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        device.waitForIdle(5_000L);
        UiObject2 visibleText = device.wait(Until.findObject(By.textContains(requiredVisibleText)), 10_000L);
        if (!hasVisibleBounds(visibleText) && isChatMessageText(scenario, requiredVisibleText)) {
            UiObject2 messageScroll = device.findObject(By.desc("메시지 기록"));
            if (messageScroll != null) {
                for (int attempt = 0; attempt < 5 && !hasVisibleBounds(visibleText); attempt++) {
                    messageScroll.swipe(Direction.UP, 0.7f);
                    device.waitForIdle(1_000L);
                    visibleText = device.wait(Until.findObject(By.textContains(requiredVisibleText)), 1_000L);
                }
            }
        }
        File directory = screenshotDirectory();
        assertNotNull("App-scoped screenshot directory must be available", directory);
        if (!directory.exists()) assertTrue("Screenshot directory must be created", directory.mkdirs());
        if (!hasVisibleBounds(visibleText)) {
            File failureScreenshot = new File(directory, fileName + ".visibility-failure.png");
            boolean screenshotSaved = device.takeScreenshot(failureScreenshot);
            throw new AssertionError("Expected app content was not visible; uiBounds="
                    + visibleBoundsMetadata(visibleText) + "; domBounds="
                    + domVisibilityMetadata(scenario, requiredVisibleText) + "; failureScreenshot="
                    + (screenshotSaved ? failureScreenshot.getName() : "capture-failed"));
        }
        File file = new File(directory, fileName);
        assertTrue("Visible app screenshot must be captured", device.takeScreenshot(file));
    }

    private static boolean hasVisibleBounds(UiObject2 object) {
        if (object == null) return false;
        try {
            android.graphics.Rect bounds = object.getVisibleBounds();
            android.graphics.Rect screen = new android.graphics.Rect(0, 0,
                    UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).getDisplayWidth(),
                    UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).getDisplayHeight());
            return !bounds.isEmpty() && android.graphics.Rect.intersects(bounds, screen);
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static String visibleBoundsMetadata(UiObject2 object) {
        if (object == null) return "not-found";
        try {
            android.graphics.Rect bounds = object.getVisibleBounds();
            return "intersectsDisplay=" + hasVisibleBounds(object) + ",rect=" + bounds.left + "," + bounds.top
                    + "," + bounds.right + "," + bounds.bottom;
        } catch (RuntimeException unavailable) {
            return "unavailable";
        }
    }

    private static boolean isChatMessageText(ActivityScenario<MainActivity> scenario, String text) throws Exception {
        return evaluateBoolean(scenario, "Array.from(document.querySelectorAll('.message-scroll .message-bubble p')).some(p=>p.textContent.includes(" + JSONObject.quote(text) + "))");
    }

    private static String domVisibilityMetadata(ActivityScenario<MainActivity> scenario, String text) {
        try {
            return evaluateString(scenario, "(() => {const e=Array.from(document.querySelectorAll('.message-scroll .message-bubble p,.profile-card strong,.attachment-staging li')).find(x=>x.textContent.includes(" + JSONObject.quote(text) + "));if(!e)return JSON.stringify({found:false,readyState:document.readyState,viewportHeight:window.visualViewport?.height||0});const r=e.getBoundingClientRect();const root=e.closest('.message-scroll');return JSON.stringify({found:true,tag:e.tagName,className:typeof e.className==='string'?e.className:'',top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height),viewportHeight:Math.round(window.visualViewport?.height||window.innerHeight),clientHeight:root?.clientHeight||0,scrollHeight:root?.scrollHeight||0,scrollTop:root?.scrollTop||0});})()");
        } catch (Exception unavailable) {
            return "unavailable";
        }
    }

    private static File screenshotDirectory() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext()
                .getExternalFilesDir("instrumentation");
    }

    private static void exerciseImeWithoutSending(ActivityScenario<MainActivity> scenario, String messageText) throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 30)
            failWithScreenshot(scenario, "ime-api-unavailable.png", "IME insets visibility requires Android API 30 or later", webComposerMetadata(scenario));
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        UiObject2 composer = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 10_000L);
        if (composer == null) failWithScreenshot(scenario, "ime-composer-missing.png", "Composer was not accessible", webComposerMetadata(scenario));
        composer.click();
        waitForImeVisibility(scenario, true, 10_000L);
        composer.setText("IME probe 42");
        try {
            waitFor(scenario, "document.querySelector('textarea[aria-label=\\\"메시지 입력\\\"]')?.value === 'IME probe 42' && !document.querySelector('.composer .send-button').disabled");
        } catch (AssertionError failed) {
            failWithScreenshot(scenario, "ime-input-failure.png", "IME text did not reach the composer", webComposerMetadata(scenario));
        }

        String metadata = webComposerMetadata(scenario);
        JSONObject viewport = new JSONObject(metadata);
        JSONObject composerBounds = viewport.optJSONObject("composer");
        JSONObject sendBounds = viewport.optJSONObject("send");
        if (!imeVisible(scenario) || composerBounds == null || sendBounds == null
                || !composerBounds.optBoolean("inside") || !sendBounds.optBoolean("inside")) {
            failWithScreenshot(scenario, "ime-layout-failure.png",
                    "IME visibility or composer/send viewport bounds failed; imeVisible=" + imeVisible(scenario), metadata);
        }

        composer.setText("");
        waitFor(scenario, "document.querySelector('textarea[aria-label=\\\"메시지 입력\\\"]')?.value === ''");
        waitFor(scenario, "Array.from(document.querySelectorAll('.message-bubble p')).some(p=>p.textContent === " + JSONObject.quote(messageText) + ")");
    }

    private static void waitForImeVisibility(ActivityScenario<MainActivity> scenario, boolean expected, long timeoutMs) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (System.nanoTime() < deadline) {
            if (imeVisible(scenario) == expected) return;
            Thread.sleep(100L);
        }
        failWithScreenshot(scenario, "ime-insets-failure.png",
                "Expected IME visibility=" + expected + "; actual=" + imeVisible(scenario), webComposerMetadata(scenario));
    }

    private static boolean imeVisible(ActivityScenario<MainActivity> scenario) {
        AtomicReference<Boolean> visible = new AtomicReference<>(false);
        scenario.onActivity(activity -> {
            if (android.os.Build.VERSION.SDK_INT < 30) {
                visible.set(false);
                return;
            }
            android.view.WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
            visible.set(insets != null && insets.isVisible(android.view.WindowInsets.Type.ime()));
        });
        return Boolean.TRUE.equals(visible.get());
    }

    private static String webComposerMetadata(ActivityScenario<MainActivity> scenario) {
        try {
            return evaluateString(scenario, "(() => {const v=window.visualViewport;const box=s=>{const e=document.querySelector(s);if(!e)return {found:false,inside:false};const r=e.getBoundingClientRect(),c=getComputedStyle(e);const left=v?.offsetLeft||0,top=v?.offsetTop||0,width=v?.width||innerWidth,height=v?.height||innerHeight;return {found:true,inside:r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'&&r.left>=left&&r.top>=top&&r.right<=left+width&&r.bottom<=top+height,left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)};};return JSON.stringify({viewport:{width:Math.round(v?.width||innerWidth),height:Math.round(v?.height||innerHeight),offsetTop:Math.round(v?.offsetTop||0)},composer:box('textarea[aria-label=\\\"메시지 입력\\\"]'),send:box('.composer .send-button')});})()");
        } catch (Exception unavailable) {
            return "{}";
        }
    }

    private static void waitForLandscape(UiDevice device, ActivityScenario<MainActivity> scenario, String groupTitle, String messageText) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline && device.getDisplayWidth() <= device.getDisplayHeight()) Thread.sleep(100L);
        String size = device.getDisplayWidth() + "x" + device.getDisplayHeight();
        if (device.getDisplayWidth() <= device.getDisplayHeight())
            failWithScreenshot(scenario, "landscape-rotation-failure.png", "Landscape display was not reached; display=" + size, webComposerMetadata(scenario));
        if (scenario.getState() != Lifecycle.State.RESUMED)
            failWithScreenshot(scenario, "landscape-activity-failure.png", "Activity state after rotation=" + scenario.getState(), webComposerMetadata(scenario));
        try {
            waitFor(scenario, "document.querySelector('.profile-card strong')?.textContent.trim() === 'Alice' && document.querySelector('.chat-header h1')?.textContent.trim() === " + JSONObject.quote(groupTitle) + " && Array.from(document.querySelectorAll('.message-bubble p')).some(p => p.textContent === " + JSONObject.quote(messageText) + ")");
        } catch (AssertionError failed) {
            failWithScreenshot(scenario, "landscape-session-failure.png", "Alice session or current conversation did not survive rotation; display=" + size, domVisibilityMetadata(scenario, messageText));
        }
    }

    private static void waitForPortrait(UiDevice device, ActivityScenario<MainActivity> scenario) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline && device.getDisplayWidth() >= device.getDisplayHeight()) Thread.sleep(100L);
        if (device.getDisplayWidth() >= device.getDisplayHeight())
            failWithScreenshot(scenario, "portrait-restore-failure.png", "Device did not return to natural portrait orientation; display=" + device.getDisplayWidth() + "x" + device.getDisplayHeight(), webComposerMetadata(scenario));
    }

    private static void failWithScreenshot(ActivityScenario<MainActivity> scenario, String name, String reason, String metadata) {
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        File directory = screenshotDirectory();
        boolean saved = false;
        String pathName = "capture-failed";
        if (directory != null && (directory.exists() || directory.mkdirs())) {
            File screenshot = new File(directory, name);
            saved = device.takeScreenshot(screenshot);
            if (saved) pathName = screenshot.getName();
        }
        throw new AssertionError(reason + "; state=" + scenario.getState() + "; screenshot=" + pathName + "; layout=" + metadata);
    }

    private static void installDownloadAckObserver(ActivityScenario<MainActivity> scenario) throws Exception {
        String script = "(() => {const transport=window.JMessengerAndroidDownloads;"
                + "if(!transport||typeof transport.postMessage!=='function')return 'unavailable';"
                + "const original=transport.onmessage; window.__jMessengerDownloadTestAck=null;"
                + "transport.onmessage=function(event){try{const value=JSON.parse(event.data);"
                + "if(value&&typeof value.id==='string'&&typeof value.saved==='boolean')"
                + "window.__jMessengerDownloadTestAck={id:value.id,saved:value.saved,error:typeof value.error==='string'?value.error:null};"
                + "}catch(_){} if(typeof original==='function')original.call(this,event);}; return 'installed';})()";
        assertEquals("installed", evaluateString(scenario, script));
    }

    private static JSONObject waitForDownloadAck(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "typeof window.__jMessengerDownloadTestAck?.id === 'string' && typeof window.__jMessengerDownloadTestAck?.saved === 'boolean'");
        String result = evaluateString(scenario, "JSON.stringify(window.__jMessengerDownloadTestAck)");
        return new JSONObject(result);
    }

    private static void selectFixtureFromDocumentPicker() {
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        openDownloadsRoot(device);
        UiObject2 fixture = device.wait(Until.findObject(By.text(FIXTURE_NAME)), 15_000L);
        assertNotNull("The seeded fixture must appear in the Android document picker", fixture);
        fixture.click();
    }

    private static void saveNativeDownloadToDownloads(String savedName) {
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        openDownloadsRoot(device);
        UiObject2 nameField = device.wait(
                Until.findObject(By.res("com.google.android.documentsui:id/name")), 10_000L);
        if (nameField == null) nameField = device.findObject(By.clazz("android.widget.EditText"));
        assertNotNull("The Android save picker must expose its document name field", nameField);
        nameField.setText(savedName);
        UiObject2 save = device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)save"))), 10_000L);
        assertNotNull("The Android save picker must expose Save", save);
        save.click();
    }

    private static void openDownloadsRoot(UiDevice device) {
        UiObject2 roots = device.findObject(By.desc("Show roots"));
        if (roots != null) {
            roots.click();
            UiObject2 downloads = device.wait(Until.findObject(By.text("Downloads")), 5_000L);
            assertNotNull("The Android document picker must offer Downloads", downloads);
            downloads.click();
        }
    }

    private static byte[] readSharedFile(String path) throws Exception {
        boolean knownFixture = FIXTURE_PATH.equals(path);
        boolean knownSavedFile = path.matches("/sdcard/Download/jmessenger-saved-[0-9a-f]{8}\\.txt");
        if (!knownFixture && !knownSavedFile) throw new IllegalArgumentException("Unexpected fixture path");
        UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        ParcelFileDescriptor descriptor = automation.executeShellCommand("cat " + path);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            return readBytes(input);
        }
    }

    private static byte[] waitForSharedFile(String path, byte[] expectedBytes) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            byte[] candidate = readSharedFile(path);
            if (MessageDigest.isEqual(expectedBytes, candidate)) return candidate;
            Thread.sleep(200);
        }
        throw new AssertionError("The saved document did not match the fixture before timeout");
    }

    private static byte[] readBytes(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        return output.toByteArray();
    }

    private static VmSession loginBob() throws Exception {
        SSLContext ssl = vmSslContext();
        JSONObject body = new JSONObject();
        body.put("serverId", SERVER_ID);
        body.put("username", "bob");
        body.put("password", PASSWORD);
        HttpResult response = request(ssl, "POST", "/api/v1/session", null, body.toString());
        assertEquals("Bob's synthetic lab session must be accepted", 201, response.status);
        String cookie = response.connectionCookie;
        assertNotNull("Session response must set an HttpOnly session cookie", cookie);
        return new VmSession(ssl, cookie, response.json.getJSONObject("data"));
    }

    private static JSONObject findConversation(VmSession session, String title) throws Exception {
        JSONObject response = request(session.ssl, "GET", "/api/v1/conversations?limit=100", session.cookie, null).json;
        JSONArray conversations = response.getJSONArray("data");
        for (int i = 0; i < conversations.length(); i++) {
            JSONObject conversation = conversations.getJSONObject(i);
            if (title.equals(conversation.optString("title"))) return conversation;
        }
        return null;
    }

    private static boolean hasMessage(VmSession session, String conversationId, String text) throws Exception {
        JSONObject response = request(session.ssl, "GET", "/api/v1/conversations/" + conversationId + "/messages?limit=100", session.cookie, null).json;
        JSONArray messages = response.getJSONArray("data");
        for (int i = 0; i < messages.length(); i++) {
            if (text.equals(messages.getJSONObject(i).optString("text"))) return true;
        }
        return false;
    }

    private static JSONObject findMessage(VmSession session, String conversationId, String text) throws Exception {
        JSONObject response = request(session.ssl, "GET", "/api/v1/conversations/" + conversationId + "/messages?limit=100", session.cookie, null).json;
        JSONArray messages = response.getJSONArray("data");
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            if (text.equals(message.optString("text"))) return message;
        }
        return null;
    }

    private static byte[] downloadFileBytes(VmSession session, String fileId) throws Exception {
        javax.net.ssl.HttpsURLConnection connection = (javax.net.ssl.HttpsURLConnection)
                new URL(VM_BASE + "/api/v1/files/" + fileId + "/content").openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/octet-stream, */*");
        connection.setRequestProperty("Origin", VM_BASE);
        connection.setRequestProperty("Cookie", session.cookie);
        connection.setSSLSocketFactory(session.ssl.getSocketFactory());
        try {
            assertEquals("Bob's authorized file download must succeed", 200, connection.getResponseCode());
            try (InputStream input = connection.getInputStream()) {
                return readBytes(input);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void postMessage(VmSession session, String conversationId, String text) throws Exception {
        JSONObject body = new JSONObject();
        body.put("clientMessageId", UUID.randomUUID().toString());
        body.put("text", text);
        HttpResult response = request(session.ssl, "POST", "/api/v1/conversations/" + conversationId + "/messages", session.cookie, body.toString());
        assertTrue("Bob's authenticated API message must be accepted", response.status == 200 || response.status == 201);
    }

    private static boolean containsString(JSONArray values, String expected) {
        for (int i = 0; i < values.length(); i++) if (expected.equals(values.optString(i))) return true;
        return false;
    }

    private static SSLContext vmSslContext() throws Exception {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        Certificate certificate;
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getTargetContext()
                .getResources().openRawResource(R.raw.vm_lab_ca)) {
            certificate = factory.generateCertificate(input);
        }
        KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
        trustStore.load(null);
        trustStore.setCertificateEntry("vm-lab-ca", certificate);
        TrustManagerFactory trustManagers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trustManagers.init(trustStore);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustManagers.getTrustManagers(), new SecureRandom());
        return context;
    }

    private static HttpResult request(SSLContext ssl, String method, String path, String cookie, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(VM_BASE + path).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Origin", VM_BASE);
        if (connection instanceof javax.net.ssl.HttpsURLConnection)
            ((javax.net.ssl.HttpsURLConnection) connection).setSSLSocketFactory(ssl.getSocketFactory());
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
        String responseText = "";
        if (stream != null) {
            try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                responseText = output.toString(java.nio.charset.StandardCharsets.UTF_8.name());
            }
        }
        String setCookie = connection.getHeaderField("Set-Cookie");
        connection.disconnect();
        String sessionCookie = null;
        if (setCookie != null) {
            int end = setCookie.indexOf(';');
            sessionCookie = end >= 0 ? setCookie.substring(0, end) : setCookie;
        }
        JSONObject json = responseText.isEmpty() ? new JSONObject() : new JSONObject(responseText);
        return new HttpResult(status, json, sessionCookie);
    }

    private static final class VmSession {
        final SSLContext ssl;
        final String cookie;
        final JSONObject user;

        VmSession(SSLContext ssl, String cookie, JSONObject user) {
            this.ssl = ssl;
            this.cookie = cookie;
            this.user = user;
        }
    }

    private static final class HttpResult {
        final int status;
        final JSONObject json;
        final String connectionCookie;

        HttpResult(int status, JSONObject json, String connectionCookie) {
            this.status = status;
            this.json = json;
            this.connectionCookie = connectionCookie;
        }
    }
}
