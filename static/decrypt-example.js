async function decryptContent() {
    const encryptedContent = document.getElementById('encryptedContent').value.trim();
    const passphrase = document.getElementById('passphrase').value;
    const resultDiv = document.getElementById('result');

    // Clear previous result
    resultDiv.innerHTML = '';

    // Validate inputs
    if (!encryptedContent) {
        resultDiv.innerHTML = '<div class="error">Please enter encrypted content</div>';
        return;
    }

    if (!passphrase) {
        resultDiv.innerHTML = '<div class="error">Please enter a passphrase</div>';
        return;
    }

    try {
        // Decrypt the content
        const decrypted = await NaginiCrypto.decrypt(encryptedContent, passphrase);

        // Display success and decrypted content
        resultDiv.innerHTML = `
            <div class="success">✅ Decryption successful!</div>
            <div class="result">
                <h3 style="color: #4a9eff; margin-bottom: 10px;">Decrypted Script Content:</h3>
                <pre><code>${escapeHtml(decrypted)}</code></pre>
            </div>
        `;
    } catch (error) {
        resultDiv.innerHTML = `
            <div class="error">
                <strong>❌ Decryption failed:</strong><br>
                ${escapeHtml(error.message)}
                <br><br>
                <small>Make sure you're using the correct passphrase and the content is a valid encrypted Nagini script.</small>
            </div>
        `;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.getElementById('decryptButton').addEventListener('click', decryptContent);

// Allow Enter key in passphrase field
document.getElementById('passphrase').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        decryptContent();
    }
});
