/**
 * ui.js - Page-level UI logic (auth modals, panels, shortcuts) and event wiring.
 *
 * Event handlers are bound via data-* attributes instead of inline on*="" attributes,
 * so the page works under a Content-Security-Policy without 'unsafe-inline' scripts:
 *   data-click="name" [data-arg="true"]   click
 *   data-enter="name"                      Enter key in an input
 *   data-input="name" / data-change="name" input / change events (handler receives the event)
 * Only names in UI_ACTIONS can be invoked.
 */

// Must match the server-side minimum in main.go
const MIN_PASSWORD_LENGTH = 12;

const UI_ACTIONS = new Set([
  "app.clearCanvas",
  "app.closeDeleteBlockConfirmation",
  "app.closeDeleteCompositionConfirmation",
  "app.closeEditBlockModal",
  "app.closeLoadModal",
  "app.closeSaveModal",
  "app.copyCompositionPassphrase",
  "app.copyCompositionUrl",
  "app.copyNaginiParameters",
  "app.createNewBlock",
  "app.doDeleteBlock",
  "app.doDeleteComposition",
  "app.doEditBlock",
  "app.doSave",
  "app.generatePassphraseAndPublish",
  "app.importVariablesFromFile",
  "app.loadComposition",
  "app.publishComposition",
  "app.saveComposition",
  "app.showDeleteBlockConfirmation",
  "app.validatePublishPassphrase",
  "closeInfoPanel",
  "closeLoginModal",
  "closeMetadataPanel",
  "closePreviewPanel",
  "closeRegisterModal",
  "closeUserSettingsModal",
  "closeVariablesPanel",
  "closeVersionModal",
  "copyPreviewContent",
  "doChangeEmail",
  "doChangePassword",
  "doLogin",
  "doLogout",
  "doRegister",
  "filterBlocksFromSearch",
  "openVariablesFileDialog",
  "publishIfEnabled",
  "showRegisterModal",
  "showVersionModal",
  "toggleInfoPanel",
  "toggleMetadataPanel",
  "togglePreviewPanel",
  "toggleVariablesPanel",
]);

function resolveUiAction(name) {
  if (!UI_ACTIONS.has(name)) {
    console.error("Unknown UI action:", name);
    return null;
  }
  if (name.startsWith("app.")) {
    const method = name.slice(4);
    if (window.app && typeof window.app[method] === "function") {
      return window.app[method].bind(window.app);
    }
    return null;
  }
  return typeof window[name] === "function" ? window[name] : null;
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-click]");
  if (!el) return;
  const fn = resolveUiAction(el.dataset.click);
  if (!fn) return;
  if (el.dataset.arg === "true") {
    fn(true);
  } else {
    fn();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const el = e.target.closest("[data-enter]");
  if (!el) return;
  const fn = resolveUiAction(el.dataset.enter);
  if (fn) fn();
});

for (const type of ["input", "change"]) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest(`[data-${type}]`);
    if (!el) return;
    const fn = resolveUiAction(el.dataset[type]);
    if (fn) fn(e);
  });
}

function filterBlocksFromSearch() {
  const input = document.getElementById("blockSearchInput");
  filterBlocksList(input ? input.value : "");
}

function openVariablesFileDialog() {
  const input = document.getElementById("variablesFileInput");
  if (input) input.click();
}

function publishIfEnabled() {
  const button = document.getElementById("publishButton");
  if (button && !button.disabled && window.app) {
    window.app.publishComposition();
  }
}

function filterBlocksList(query) {
    const blocksList =
        document.getElementById("blocksList");
    if (!blocksList) return;
    const invert =
        document.getElementById(
            "blockSearchInvert",
        ).checked;
    const items =
        blocksList.querySelectorAll(".block-item");
    const lowerQuery = query.toLowerCase().trim();
    items.forEach(function (item) {
        const nameEl =
            item.querySelector(".block-name");
        const name = nameEl
            ? nameEl.textContent.toLowerCase()
            : "";
        const tags = (
            item.dataset.tags || ""
        ).toLowerCase();
        const found =
            name.includes(lowerQuery) ||
            tags.includes(lowerQuery);
        const matches =
            !lowerQuery ||
            (invert ? !found : found);
        item.style.display = matches ? "" : "none";
    });
}

function copyPreviewContent() {
    const previewContent =
        document.getElementById("previewContent");
    if (
        !previewContent ||
        previewContent.classList.contains("empty")
    ) {
        return;
    }
    const text = previewContent.textContent;
    navigator.clipboard
        .writeText(text)
        .then(() => {
            const btn =
                document.getElementById(
                    "previewCopyButton",
                );
            if (btn) {
                const original = btn.innerHTML;
                btn.innerHTML = "✓";
                setTimeout(() => {
                    btn.innerHTML = original;
                }, 1000);
            }
        })
        .catch((err) => {
            console.error(
                "Failed to copy script preview:",
                err,
            );
        });
}

// Version Modal Functions
async function showVersionModal() {
    const modal = document.getElementById("versionModal");
    const versionText = document.getElementById("versionText");

    modal.classList.add("active");

    try {
        const response = await fetch("/api/version", {
            credentials: "same-origin",
        });
        const data = await response.json();
        versionText.textContent = data.version;
    } catch (error) {
        console.error("Error fetching version:", error);
        versionText.textContent = "Unknown";
    }
}

function closeVersionModal() {
    const modal = document.getElementById("versionModal");
    modal.classList.remove("active");
}

// Close version modal on Escape key
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const versionModal =
            document.getElementById("versionModal");
        if (versionModal.classList.contains("active")) {
            closeVersionModal();
        }
        const loginModal = document.getElementById("loginModal");
        if (loginModal.classList.contains("active")) {
            closeLoginModal();
        }
        const userSettingsModal =
            document.getElementById("userSettingsModal");
        if (userSettingsModal.classList.contains("active")) {
            closeUserSettingsModal();
        }
        const registerModal =
            document.getElementById("registerModal");
        if (registerModal.classList.contains("active")) {
            closeRegisterModal();
        }
    }
});

// Authentication functions
window.currentUser = null;

async function checkAuthStatus() {
    try {
        const response = await fetch("/api/auth/me", {
            credentials: "same-origin",
        });
        const data = await response.json();
        window.currentUser = data;
        window.registrationEnabled = !!data.registration_enabled;
        updateLoginButton();
        // Re-render blocks to show/hide edit icons
        if (window.app) {
            app.renderBlocks();
        }
    } catch (error) {
        console.error("Error checking auth status:", error);
        window.currentUser = {
            authenticated: false,
            role: "anonymous",
        };
        updateLoginButton();
    }
}

function updateLoginButton() {
    const loginButton = document.getElementById("loginButton");
    const loginButtonText =
        document.getElementById("loginButtonText");
    const newBlockButton =
        document.getElementById("newBlockButton");
    const saveButton = document.getElementById("saveButton");
    const clearButton = document.getElementById("clearButton");

    if (!loginButton || !loginButtonText) {
        console.error("Login button elements not found");
        return;
    }

    if (window.currentUser && window.currentUser.authenticated) {
        loginButtonText.textContent = window.currentUser.username;
        loginButton.classList.add("success");
        loginButton.onclick = function (e) {
            e.preventDefault();
            showUserMenu();
        };

        // Show/hide admin-only buttons based on role
        const isAdmin = window.currentUser.role === "admin";
        if (newBlockButton) {
            newBlockButton.style.display = isAdmin
                ? "block"
                : "none";
        }
        if (saveButton) {
            saveButton.style.display = isAdmin ? "flex" : "none";
        }
        if (clearButton) {
            clearButton.style.display = isAdmin ? "flex" : "none";
        }
    } else {
        loginButtonText.textContent = "Login";
        loginButton.classList.remove("success");
        loginButton.onclick = function (e) {
            e.preventDefault();
            showLoginModal();
        };

        // Hide admin-only buttons for non-authenticated users
        if (newBlockButton) {
            newBlockButton.style.display = "none";
        }
        if (saveButton) {
            saveButton.style.display = "none";
        }
        if (clearButton) {
            clearButton.style.display = "none";
        }
    }
}

function showUserMenu() {
    showUserSettingsModal();
}

function showUserSettingsModal() {
    const modal = document.getElementById("userSettingsModal");
    const usernameDisplay =
        document.getElementById("settingsUsername");
    const roleDisplay = document.getElementById("settingsRole");
    const emailDisplay = document.getElementById("settingsEmail");
    const errorDiv = document.getElementById("passwordChangeError");
    const successDiv = document.getElementById(
        "passwordChangeSuccess",
    );
    const emailErrorDiv =
        document.getElementById("emailChangeError");
    const emailSuccessDiv =
        document.getElementById("emailChangeSuccess");

    usernameDisplay.textContent = window.currentUser.username;
    roleDisplay.textContent = window.currentUser.role;
    emailDisplay.textContent =
        window.currentUser.email || "Not set";

    // Clear password fields
    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("confirmPassword").value = "";

    // Clear email field
    document.getElementById("newEmail").value = "";

    // Hide messages
    errorDiv.style.display = "none";
    successDiv.style.display = "none";
    emailErrorDiv.style.display = "none";
    emailSuccessDiv.style.display = "none";

    modal.classList.add("active");
}

function closeUserSettingsModal() {
    const modal = document.getElementById("userSettingsModal");
    modal.classList.remove("active");
}

async function showLoginModal() {
    const modal = document.getElementById("loginModal");
    const errorDiv = document.getElementById("loginError");
    const usernameInput = document.getElementById("loginUsername");
    const passwordInput = document.getElementById("loginPassword");
    const registerSection = document.getElementById(
        "loginRegisterSection",
    );

    // Registration is enabled/disabled server-side (NAGINI_ALLOW_REGISTRATION)
    registerSection.style.display = window.registrationEnabled ? "block" : "none";

    modal.classList.add("active");
    errorDiv.style.display = "none";
    usernameInput.value = "";
    passwordInput.value = "";

    setTimeout(() => {
        usernameInput.focus();
    }, 100);
}

function closeLoginModal() {
    const modal = document.getElementById("loginModal");
    modal.classList.remove("active");
}

async function doLogin() {
    const username = document
        .getElementById("loginUsername")
        .value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorDiv = document.getElementById("loginError");

    if (!username || !password) {
        errorDiv.textContent = "Please enter username and password";
        errorDiv.style.display = "block";
        return;
    }

    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ username, password }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            closeLoginModal();
            await checkAuthStatus();
        } else {
            errorDiv.textContent =
                data.error || "Login failed. Please try again.";
            errorDiv.style.display = "block";
        }
    } catch (error) {
        console.error("Login error:", error);
        errorDiv.textContent =
            "An error occurred. Please try again.";
        errorDiv.style.display = "block";
    }
}

async function doLogout() {
    try {
        const response = await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
        });

        if (response.ok) {
            window.currentUser = null;
            updateLoginButton();
            closeUserSettingsModal();
            // Re-render blocks to hide edit icons
            if (window.app) {
                app.renderBlocks();
            }
        }
    } catch (error) {
        console.error("Logout error:", error);
    }
}

async function doChangePassword() {
    const currentPassword =
        document.getElementById("currentPassword").value;
    const newPassword =
        document.getElementById("newPassword").value;
    const confirmPassword =
        document.getElementById("confirmPassword").value;
    const errorDiv = document.getElementById("passwordChangeError");
    const successDiv = document.getElementById(
        "passwordChangeSuccess",
    );

    // Hide previous messages
    errorDiv.style.display = "none";
    successDiv.style.display = "none";

    // Validate inputs
    if (!currentPassword || !newPassword || !confirmPassword) {
        errorDiv.textContent = "Please fill in all password fields";
        errorDiv.style.display = "block";
        return;
    }

    if (newPassword !== confirmPassword) {
        errorDiv.textContent = "New passwords do not match";
        errorDiv.style.display = "block";
        return;
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        errorDiv.textContent =
            `New password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
        errorDiv.style.display = "block";
        return;
    }

    try {
        const response = await fetch("/api/auth/change-password", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword,
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            successDiv.textContent =
                "Password changed successfully!";
            successDiv.style.display = "block";

            // Clear password fields
            document.getElementById("currentPassword").value = "";
            document.getElementById("newPassword").value = "";
            document.getElementById("confirmPassword").value = "";
        } else {
            errorDiv.textContent =
                data.error ||
                "Failed to change password. Please try again.";
            errorDiv.style.display = "block";
        }
    } catch (error) {
        console.error("Password change error:", error);
        errorDiv.textContent =
            "An error occurred. Please try again.";
        errorDiv.style.display = "block";
    }
}

function showRegisterModal() {
    closeLoginModal();
    const modal = document.getElementById("registerModal");
    const errorDiv = document.getElementById("registerError");
    const successDiv = document.getElementById("registerSuccess");
    const usernameInput =
        document.getElementById("registerUsername");
    const emailInput = document.getElementById("registerEmail");
    const passwordInput =
        document.getElementById("registerPassword");
    const confirmPasswordInput = document.getElementById(
        "registerConfirmPassword",
    );

    modal.classList.add("active");
    errorDiv.style.display = "none";
    successDiv.style.display = "none";
    usernameInput.value = "";
    emailInput.value = "";
    passwordInput.value = "";
    confirmPasswordInput.value = "";

    setTimeout(() => {
        usernameInput.focus();
    }, 100);
}

function closeRegisterModal() {
    const modal = document.getElementById("registerModal");
    modal.classList.remove("active");
}

async function doRegister() {
    const username = document
        .getElementById("registerUsername")
        .value.trim();
    const email = document
        .getElementById("registerEmail")
        .value.trim();
    const password =
        document.getElementById("registerPassword").value;
    const confirmPassword = document.getElementById(
        "registerConfirmPassword",
    ).value;
    const errorDiv = document.getElementById("registerError");
    const successDiv = document.getElementById("registerSuccess");

    errorDiv.style.display = "none";
    successDiv.style.display = "none";

    if (!username || !email || !password || !confirmPassword) {
        errorDiv.textContent = "Please fill in all fields";
        errorDiv.style.display = "block";
        return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        errorDiv.textContent = "Please enter a valid email address";
        errorDiv.style.display = "block";
        return;
    }

    if (password !== confirmPassword) {
        errorDiv.textContent = "Passwords do not match";
        errorDiv.style.display = "block";
        return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        errorDiv.textContent =
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
        errorDiv.style.display = "block";
        return;
    }

    try {
        const response = await fetch("/api/auth/register", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ username, email, password }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            successDiv.textContent =
                "Account created successfully! You can now login.";
            successDiv.style.display = "block";

            // Clear form
            document.getElementById("registerUsername").value = "";
            document.getElementById("registerEmail").value = "";
            document.getElementById("registerPassword").value = "";
            document.getElementById(
                "registerConfirmPassword",
            ).value = "";

            // Close modal and open login after 2 seconds
            setTimeout(() => {
                closeRegisterModal();
                showLoginModal();
            }, 2000);
        } else {
            errorDiv.textContent =
                data.error ||
                "Registration failed. Please try again.";
            errorDiv.style.display = "block";
        }
    } catch (error) {
        console.error("Registration error:", error);
        errorDiv.textContent =
            "An error occurred. Please try again.";
        errorDiv.style.display = "block";
    }
}

async function doChangeEmail() {
    const newEmail = document
        .getElementById("newEmail")
        .value.trim();
    const errorDiv = document.getElementById("emailChangeError");
    const successDiv =
        document.getElementById("emailChangeSuccess");

    // Hide previous messages
    errorDiv.style.display = "none";
    successDiv.style.display = "none";

    // Validate input
    if (!newEmail) {
        errorDiv.textContent = "Please enter an email address";
        errorDiv.style.display = "block";
        return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
        errorDiv.textContent = "Please enter a valid email address";
        errorDiv.style.display = "block";
        return;
    }

    try {
        const response = await fetch("/api/auth/update-email", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                email: newEmail,
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            successDiv.textContent = "Email updated successfully!";
            successDiv.style.display = "block";

            // Update current user email
            window.currentUser.email = newEmail;
            document.getElementById("settingsEmail").textContent =
                newEmail;

            // Clear email field
            document.getElementById("newEmail").value = "";
        } else {
            errorDiv.textContent =
                data.error ||
                "Failed to update email. Please try again.";
            errorDiv.style.display = "block";
        }
    } catch (error) {
        console.error("Email update error:", error);
        errorDiv.textContent =
            "An error occurred. Please try again.";
        errorDiv.style.display = "block";
    }
}

// Initialize login button and check auth status on page load
document.addEventListener("DOMContentLoaded", function () {
    checkAuthStatus();
});

// Also check immediately if DOM is already loaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
        checkAuthStatus();
    });
} else {
    checkAuthStatus();
}

function closeInfoPanel() {
    const panel = document.getElementById("infoPanel");
    const helpBtn = document.getElementById("helpButton");
    panel.classList.add("hidden");
    helpBtn.classList.remove("primary");
    // Remove the opened flag so it stays closed
    localStorage.removeItem("nagini-help-opened");
}

function showInfoPanel() {
    const panel = document.getElementById("infoPanel");
    const helpBtn = document.getElementById("helpButton");
    panel.classList.remove("hidden");
    helpBtn.classList.add("primary");
    // Store that help was opened
    localStorage.setItem("nagini-help-opened", "true");
}

function toggleInfoPanel() {
    const panel = document.getElementById("infoPanel");
    if (panel.classList.contains("hidden")) {
        showInfoPanel();
    } else {
        closeInfoPanel();
    }
}

function closeVariablesPanel() {
    const panel = document.getElementById("variablesPanel");
    const variablesBtn = document.getElementById("variablesButton");
    panel.classList.add("hidden");
    variablesBtn.classList.remove("primary");
    localStorage.setItem("nagini-variables-opened", "false");
}

function showVariablesPanel() {
    const panel = document.getElementById("variablesPanel");
    const variablesBtn = document.getElementById("variablesButton");
    panel.classList.remove("hidden");
    variablesBtn.classList.add("primary");
    localStorage.setItem("nagini-variables-opened", "true");
    // Update variables list when panel is shown
    if (window.app) {
        window.app.updateVariablesList();
    }
}

function toggleVariablesPanel() {
    const panel = document.getElementById("variablesPanel");
    if (panel.classList.contains("hidden")) {
        showVariablesPanel();
    } else {
        closeVariablesPanel();
    }
}

function closeMetadataPanel() {
    const panel = document.getElementById("metadataPanel");
    const metadataBtn = document.getElementById("metadataButton");
    panel.classList.add("hidden");
    metadataBtn.classList.remove("primary");
    localStorage.setItem("nagini-metadata-opened", "false");
}

function showMetadataPanel() {
    const panel = document.getElementById("metadataPanel");
    const metadataBtn = document.getElementById("metadataButton");
    panel.classList.remove("hidden");
    metadataBtn.classList.add("primary");
    localStorage.setItem("nagini-metadata-opened", "true");
}

function toggleMetadataPanel() {
    const panel = document.getElementById("metadataPanel");
    if (panel.classList.contains("hidden")) {
        showMetadataPanel();
    } else {
        closeMetadataPanel();
    }
}

function closePreviewPanel() {
    const panel = document.getElementById("previewPanel");
    const previewBtn = document.getElementById("previewButton");
    panel.classList.add("hidden");
    previewBtn.classList.remove("primary");
    localStorage.setItem("nagini-preview-opened", "false");
}

function showPreviewPanel() {
    const panel = document.getElementById("previewPanel");
    const previewBtn = document.getElementById("previewButton");
    panel.classList.remove("hidden");
    previewBtn.classList.add("primary");
    localStorage.setItem("nagini-preview-opened", "true");
}

function togglePreviewPanel() {
    const panel = document.getElementById("previewPanel");
    if (panel.classList.contains("hidden")) {
        showPreviewPanel();
    } else {
        closePreviewPanel();
    }
}

// Preview panel resize functionality
let isResizing = false;
let startY = 0;
let startHeight = 0;

const previewPanel = document.getElementById("previewPanel");
const resizeHandle = document.getElementById("previewResizeHandle");

if (resizeHandle && previewPanel) {
    resizeHandle.addEventListener("mousedown", (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = previewPanel.offsetHeight;
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;

        const deltaY = startY - e.clientY;
        const newHeight = startHeight + deltaY;

        // Constrain height between min and max
        const minHeight = 100;
        const maxHeight = window.innerHeight * 0.8;
        const constrainedHeight = Math.max(
            minHeight,
            Math.min(newHeight, maxHeight),
        );

        previewPanel.style.height = constrainedHeight + "px";
        localStorage.setItem(
            "nagini-preview-height",
            constrainedHeight,
        );
    });

    document.addEventListener("mouseup", () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
    });

    // Restore saved height
    const savedHeight = localStorage.getItem(
        "nagini-preview-height",
    );
    if (savedHeight) {
        previewPanel.style.height = savedHeight + "px";
    }
}

// Check if user previously opened panels
document.addEventListener("DOMContentLoaded", () => {
    if (localStorage.getItem("nagini-help-opened") === "true") {
        const panel = document.getElementById("infoPanel");
        const helpBtn = document.getElementById("helpButton");
        panel.classList.remove("hidden");
        helpBtn.classList.add("primary");
    }
    // Show metadata panel by default unless explicitly closed
    const metadataState = localStorage.getItem(
        "nagini-metadata-opened",
    );
    const metadataPanel = document.getElementById("metadataPanel");
    const metadataBtn = document.getElementById("metadataButton");

    if (metadataState === "false") {
        // User explicitly closed it
        metadataPanel.classList.add("hidden");
        metadataBtn.classList.remove("primary");
    } else {
        // Show by default
        metadataPanel.classList.remove("hidden");
        metadataBtn.classList.add("primary");
    }
    // Show preview panel by default unless explicitly closed
    const previewState = localStorage.getItem(
        "nagini-preview-opened",
    );
    const previewPanel = document.getElementById("previewPanel");
    const previewBtn = document.getElementById("previewButton");

    if (previewState === "false") {
        // User explicitly closed it
        previewPanel.classList.add("hidden");
        previewBtn.classList.remove("primary");
    } else {
        // Show by default
        previewPanel.classList.remove("hidden");
        previewBtn.classList.add("primary");
    }

    // ESC key handler to close modals
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || e.key === "Esc") {
            // Check if Save Modal is open
            const saveModal = document.getElementById("saveModal");
            if (
                saveModal &&
                saveModal.classList.contains("active")
            ) {
                app.closeSaveModal();
                return;
            }

            // Check if Load Modal is open
            const loadModal = document.getElementById("loadModal");
            if (
                loadModal &&
                loadModal.classList.contains("active")
            ) {
                app.closeLoadModal();
                return;
            }
        }
    });

    // Keyboard shortcuts: Ctrl+S for Save, Ctrl+O for Load
    document.addEventListener("keydown", (e) => {
        // Ctrl+S or Cmd+S for Save
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            app.saveComposition();
            return;
        }

        // Ctrl+O or Cmd+O for Load
        if ((e.ctrlKey || e.metaKey) && e.key === "o") {
            e.preventDefault();
            app.loadComposition();
            return;
        }

        // Alt+P for Preview
        if (e.altKey && e.key === "p") {
            e.preventDefault();
            togglePreviewPanel();
            return;
        }

        // Alt+M for Metadata
        if (e.altKey && e.key === "m") {
            e.preventDefault();
            toggleMetadataPanel();
            return;
        }

        // Alt+H for Help
        if (e.altKey && e.key === "h") {
            e.preventDefault();
            toggleInfoPanel();
            return;
        }

        // Alt+V for Variables
        if (e.altKey && e.key === "v") {
            e.preventDefault();
            toggleVariablesPanel();
            return;
        }
    });
});
