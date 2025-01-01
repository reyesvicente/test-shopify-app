import { useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import imageCompression from "browser-image-compression";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query {
        products(first: 10) {
          edges {
            node {
              id
              title
              images(first: 1) {
                edges {
                  node {
                    id
                    url
                  }
                }
              }
            }
          }
        }
      }`
  );

  const {
    data: { products },
  } = await response.json();

  return json({ products: products.edges });
};

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const compressedImageUrl = formData.get("compressedImageUrl");
  
  try {
    // Update product image using Admin API
    const response = await admin.graphql(
      `#graphql
        mutation productImageUpdate($input: ProductImageUpdateInput!) {
          productImageUpdate(input: $input) {
            image {
              id
              url
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            id: productId,
            image: compressedImageUrl,
          },
        },
      }
    );

    const result = await response.json();
    return json(result);
  } catch (error) {
    return json({ error: error.message }, { status: 500 });
  }
}

export default function Index() {
  const { products } = useLoaderData();
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState("");
  const [compressionStats, setCompressionStats] = useState(null);
  const submit = useSubmit();

  const compressAndUpdateImage = async (product) => {
    try {
      setIsCompressing(true);
      setError("");
      setSelectedProduct(product);

      const imageUrl = product.node.images.edges[0]?.node.url;
      if (!imageUrl) {
        throw new Error("No image found for this product");
      }

      // Fetch the image
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      const options = {
        maxSizeMB: 1,
        maxWidthOrHeight: 2048,
        useWebWorker: true,
        initialQuality: 0.8,
        preserveExif: true,
      };

      const compressedFile = await imageCompression(blob, options);
      
      // Create form data to submit
      const formData = new FormData();
      formData.append("productId", product.node.id);
      formData.append("compressedImageUrl", compressedFile);

      // Submit the compressed image
      submit(formData, { method: "post" });

      setCompressionStats({
        originalSize: (blob.size / 1024 / 1024).toFixed(2),
        compressedSize: (compressedFile.size / 1024 / 1024).toFixed(2),
        savedPercentage: (
          ((blob.size - compressedFile.size) / blob.size) *
          100
        ).toFixed(1),
      });
    } catch (err) {
      setError("Error compressing image: " + err.message);
    } finally {
      setIsCompressing(false);
    }
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
          <h2>Product Images</h2>
          <div className="products-grid">
            {products.map((product) => (
              <div key={product.node.id} className="product-card">
                <h3>{product.node.title}</h3>
                {product.node.images.edges[0] && (
                  <div className="product-image-container">
                    <img
                      src={product.node.images.edges[0].node.url}
                      alt={product.node.title}
                      className="product-image"
                    />
                    <button
                      onClick={() => compressAndUpdateImage(product)}
                      disabled={isCompressing && selectedProduct?.node.id === product.node.id}
                      className="primary-button compress-button"
                    >
                      {isCompressing && selectedProduct?.node.id === product.node.id ? (
                        <>
                          <div className="spinner"></div>
                          <span>Compressing...</span>
                        </>
                      ) : (
                        'Compress Image'
                      )}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {compressionStats && (
            <div className="compression-results">
              <h3>Compression Results</h3>
              <p>Original size: {compressionStats.originalSize} MB</p>
              <p>Compressed size: {compressionStats.compressedSize} MB</p>
              <p>Space saved: {compressionStats.savedPercentage}%</p>
            </div>
          )}
        </div>
      </div>
      <style jsx>{`
        .app-container {
          font-family: 'Lato', sans-serif;
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .products-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 20px;
          margin-top: 20px;
        }
        .product-card {
          background: white;
          border-radius: 8px;
          padding: 16px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        .product-image-container {
          position: relative;
          margin-top: 12px;
        }
        .product-image {
          width: 100%;
          height: 200px;
          object-fit: cover;
          border-radius: 4px;
        }
        .compress-button {
          margin-top: 12px;
          width: 100%;
        }
        .spinner {
          border: 2px solid #f3f3f3;
          border-top: 2px solid #ffffff;
          border-radius: 50%;
          width: 16px;
          height: 16px;
          animation: spin 1s linear infinite;
          margin-right: 8px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
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
          font-family: 'Lato', sans-serif;
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
