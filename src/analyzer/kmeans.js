/**
 * Simple K-Means Clustering Implementation
 * Used for adaptive RTT classification (Fast, Medium, Slow)
 */

class SimpleKMeans {
    constructor(k = 3) {
        this.k = k;
        this.centroids = [];
        this.clusters = [];
        this.trained = false;
    }

    /**
     * Train the k-means model with RTT data
     * @param {number[]} data - Array of RTT measurements
     */
    train(data) {
        if (!data || data.length < this.k) {
            this.trained = false;
            return false; // Return failure
        }

        // Initialize centroids with random data points
        const sorted = [...data].sort((a, b) => a - b);
        const step = Math.floor(sorted.length / this.k);
        
        this.centroids = [];
        for (let i = 0; i < this.k; i++) {
            const index = Math.min(i * step, sorted.length - 1);
            this.centroids.push(sorted[index]);
        }

        // Run k-means iterations
        const maxIterations = 10;
        for (let iter = 0; iter < maxIterations; iter++) {
            // Assign points to nearest centroid
            this.clusters = Array(this.k).fill(null).map(() => []);
            
            for (const point of data) {
                const clusterIndex = this.findNearestCentroid(point);
                this.clusters[clusterIndex].push(point);
            }

            // Update centroids
            let changed = false;
            for (let i = 0; i < this.k; i++) {
                if (this.clusters[i].length > 0) {
                    const newCentroid = this.clusters[i].reduce((a, b) => a + b, 0) / this.clusters[i].length;
                    if (Math.abs(newCentroid - this.centroids[i]) > 0.01) {
                        changed = true;
                        this.centroids[i] = newCentroid;
                    }
                }
            }

            // Converged
            if (!changed) break;
        }

        // Sort centroids (Fast, Medium, Slow)
        this.centroids.sort((a, b) => a - b);
        this.trained = true;
        
        return true; // Return success
    }

    /**
     * Find the nearest centroid for a given point
     * @param {number} point - RTT value
     * @returns {number} - Cluster index (0 = Fast, 1 = Medium, 2 = Slow)
     */
    findNearestCentroid(point) {
        if (!this.trained || this.centroids.length === 0) {
            return 0;
        }

        let minDist = Infinity;
        let nearestIndex = 0;

        for (let i = 0; i < this.centroids.length; i++) {
            const dist = Math.abs(point - this.centroids[i]);
            if (dist < minDist) {
                minDist = dist;
                nearestIndex = i;
            }
        }

        return nearestIndex;
    }

    /**
     * Classify a new RTT measurement
     * @param {number} rtt - RTT value to classify
     * @returns {string} - Cluster name (Fast, Medium, Slow, or Unknown)
     */
    classify(rtt) {
        if (!this.trained) {
            return 'Unknown';
        }

        const clusterIndex = this.findNearestCentroid(rtt);
        const clusterNames = ['Fast', 'Medium', 'Slow'];
        return clusterNames[clusterIndex] || 'Unknown';
    }

    /**
     * Get cluster centers
     * @returns {number[]} - Array of centroid values
     */
    getCentroids() {
        return [...this.centroids];
    }

    /**
     * Check if model is trained
     * @returns {boolean}
     */
    isTrained() {
        return this.trained;
    }
}

module.exports = SimpleKMeans;
