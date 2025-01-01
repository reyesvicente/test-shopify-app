import { useState } from "react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import imageCompression from "browser-image-compression";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({});
};

export default function Index() {
  const [originalImage, setOriginalImage] = useState(null);
  const [compressedImage, setCompressedImage] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState("");
  const [compressionStats, setCompressionStats] = useState(null);

  const handleDrop = async (files) => {
    const file = files[0];
    if (file) {
      setOriginalImage(file);
      setCompressedImage(null);
      setCompressionStats(null);
      setError("");
    }
  };

  const compressImage = async () => {
    try {
      setIsCompressing(true);
      setError("");

      const options = {
        maxSizeMB: 1,
        maxWidthOrHeight: 2048,
        useWebWorker: true,
        initialQuality: 0.8,  // Higher quality (0 to 1)
        alwaysKeepResolution: true,  // Maintain original resolution when possible
        preserveExif: true,  // Keep image metadata
      };

      const compressedFile = await imageCompression(originalImage, options);
      
      setCompressedImage(compressedFile);
      setCompressionStats({
        originalSize: (originalImage.size / 1024 / 1024).toFixed(2),
        compressedSize: (compressedFile.size / 1024 / 1024).toFixed(2),
        savedPercentage: (
          ((originalImage.size - compressedFile.size) / originalImage.size) *
          100
        ).toFixed(1),
      });
    } catch (err) {
      setError("Error compressing image: " + err.message);
    } finally {
      setIsCompressing(false);
    }
  };

  const downloadCompressedImage = () => {
    if (!compressedImage) return;

    const link = document.createElement("a");
    link.href = URL.createObjectURL(compressedImage);
    link.download = `compressed_${compressedImage.name}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="app-container">
      <div className="content">
        {error && (
          <div className="error-banner">
            <p>{error}</p>
            <button onClick={() => setError("")} className="dismiss-button">×</button>
          </div>
        )}

        <div className="card">
          <div className="drop-zone"
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(e.dataTransfer.files);
            }}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*';
              input.onchange = (e) => handleDrop(e.target.files);
              input.click();
            }}
          >
            <p>Drop image file to upload or click to select</p>
          </div>

          {originalImage && (
            <div className="image-info">
              <p>Selected image: {originalImage.name}</p>
              <p>Size: {(originalImage.size / 1024 / 1024).toFixed(2)} MB</p>
              <button
                onClick={compressImage}
                disabled={isCompressing}
                className="primary-button"
              >
                {isCompressing ? 'Compressing...' : 'Compress Image'}
              </button>
            </div>
          )}

          {isCompressing && (
            <div className="loading">
              <div className="spinner"></div>
              <p>Compressing image...</p>
            </div>
          )}

          {compressionStats && (
            <div className="compression-results">
              <h3>Compression Results</h3>
              <p>Original size: {compressionStats.originalSize} MB</p>
              <p>Compressed size: {compressionStats.compressedSize} MB</p>
              <p>Space saved: {compressionStats.savedPercentage}%</p>
              <button onClick={downloadCompressedImage} className="primary-button">
                Download Compressed Image
              </button>
            </div>
          )}
        </div>
      </div>
      <style jsx>{`
        .app-container {
          padding: 20px;
          max-width: 800px;
          margin: 0 auto;
        }
        .content {
          width: 100%;
        }
        .error-banner {
          background-color: #FED3D1;
          color: #D72C0D;
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .dismiss-button {
          background: none;
          border: none;
          color: #D72C0D;
          cursor: pointer;
          font-size: 20px;
        }
        .card {
          background-color: white;
          border-radius: 8px;
          padding: 24px;
          box-shadow: 0 0 0 1px rgba(63, 63, 68, 0.05), 0 1px 3px 0 rgba(63, 63, 68, 0.15);
        }
        .drop-zone {
          border: 2px dashed #C9CCCF;
          border-radius: 4px;
          padding: 32px;
          text-align: center;
          cursor: pointer;
          background-color: #F6F6F7;
          margin-bottom: 24px;
        }
        .drop-zone:hover {
          border-color: #2C6ECB;
          background-color: #F1F8FE;
        }
        .image-info {
          margin-bottom: 24px;
        }
        .primary-button {
          background-color: #008060;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }
        .primary-button:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }
        .primary-button:hover:not(:disabled) {
          background-color: #006E52;
        }
        .loading {
          text-align: center;
          margin: 24px 0;
        }
        .spinner {
          border: 3px solid #F3F3F3;
          border-top: 3px solid #008060;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          animation: spin 1s linear infinite;
          margin: 0 auto 12px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .compression-results {
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid #E1E3E5;
        }
        .compression-results h3 {
          margin: 0 0 16px;
          color: #202223;
        }
        p {
          margin: 8px 0;
          color: #202223;
        }
      `}</style>
    </div>
  );
}
