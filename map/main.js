import { auth } from '../login/firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.1.0/firebase-auth.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.1.0/firebase-database.js";
import { database } from '../login/firebase-config.js';
let map, marker, userMarker, routeLayer;
let lastData = null;
let userLocation = null;
let isSatelliteView = false;
let isMapMoving = false;
let abortController = new AbortController();
let animationFrameId = null;
let retryCount = 0;
const UPDATE_INTERVAL = 1000;
const MIN_DISTANCE_CHANGE = 0.0001;

// Thêm biến lưu lịch sử đường đi và biến polyline để vẽ đường đi
let pathHistory = [];
let gpsPolyline;

// Tile layers
const standardTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {

    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
});

const satelliteTileLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    maxZoom: 22,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
});

// Hàm hiển thị thông báo
const showNotification = (message, duration = 3000) => {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.style.display = 'block';
    setTimeout(() => notification.style.display = 'none', duration);
};

// Hàm tính khoảng cách
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Hàm khởi tạo bản đồ
const initMap = () => {
    map = L.map('map', { zoomControl: false }).setView([20.972563, 105.983978], 19);
    satelliteTileLayer.addTo(map);
    isSatelliteView = true;

    marker = L.marker([20.972563, 105.983978], {
        icon: L.divIcon({ className: 'custom-marker', html: '📍', iconSize: [32, 32] }),
        autoPan: true
    }).addTo(map);

    userMarker = L.marker([0, 0], {
        icon: L.divIcon({ className: 'user-marker', html: '👱', iconSize: [32, 32] }),
        autoPan: true
    }).addTo(map);
    map.whenReady(() => {
        console.log("Bản đồ đã tải xong!");
        map.invalidateSize();
    });

    map.on('movestart', () => isMapMoving = true);
    map.on('moveend', () => {
        isMapMoving = false;
        updateLocation();    
    });
};

// Hàm cập nhật vị trí
// Hàm cập nhật vị trí
const updateLocation = async () => {
    if (isMapMoving) return;
    try {
        const gpsRef = ref(database, 'gps');
        // Use onValue to listen for real-time updates
        onValue(gpsRef, (snapshot) => {
            // Get the most recent GPS entry
            const entries = snapshot.val();
            if (!entries) return;
            
            // Get the last entry (most recent)
            const lastEntryKey = Object.keys(entries).pop();
            const data = entries[lastEntryKey];
            
            if (data) {
                const lat = parseFloat(data.latitude);
                const lng = parseFloat(data.longitude);
                const speed = parseFloat(data.speed);
                const timestamp = data.timestamp;

                // Validate data
                if (!isNaN(lat) && !isNaN(lng) && !isNaN(speed)) {
                    const currentLatLng = marker.getLatLng();
                    const distance = calculateDistance(
                        currentLatLng.lat,
                        currentLatLng.lng,
                        lat,
                        lng
                    );

                    if (distance > MIN_DISTANCE_CHANGE) {
                        if (animationFrameId) {
                            cancelAnimationFrame(animationFrameId);
                        }
                        
                        // Smooth marker animation
                        const startLatLng = marker.getLatLng();
                        const endLatLng = L.latLng(lat, lng);
                        const duration = 1000;
                        const startTime = performance.now();

                        const animateMarker = (currentTime) => {
                            const elapsedTime = currentTime - startTime;
                            const progress = Math.min(elapsedTime / duration, 1);
                            const newLat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * progress;
                            const newLng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * progress;
                            marker.setLatLng([newLat, newLng]);

                            if (progress < 1) {
                                animationFrameId = requestAnimationFrame(animateMarker);
                            } else {
                                if (!isMapMoving) {
                                    map.flyTo([lat, lng], map.getZoom(), {
                                        animate: true,
                                        duration: 0.5
                                    });
                                }
                            }
                        };

                        animationFrameId = requestAnimationFrame(animateMarker);

                        // Update UI
                        document.getElementById('location').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                        document.getElementById('speed').textContent = `${speed.toFixed(2)} km/h`;
                        document.getElementById('date').textContent = timestamp;

                        // Update path history
                        pathHistory.push([lat, lng]);
                        if (pathHistory.length > 1) {
                            if (gpsPolyline) {
                                gpsPolyline.setLatLngs(pathHistory);
                            } else {
                                gpsPolyline = L.polyline(pathHistory, {
                                    color: 'green',
                                    weight: 4
                                }).addTo(map);
                            }
                        }

                        // Update route if user location exists
                        if (userLocation) {
                            updateRoute(lat, lng);
                        }
                    }
                } else {
                    console.error('Invalid GPS data received:', data);
                }
            }
        });

        retryCount = 0;
    } catch (error) {
        if (error.name !== "AbortError") {
            console.error("Update error:", error);
            if (retryCount < 3) {
                retryCount++;
                showNotification(`Thử lại lần ${retryCount}/3...`);
                setTimeout(updateLocation, 1000 * retryCount);
            } else {
                showNotification("Mất kết nối, vui lòng thử lại sau");
            }
        }
    }
};

// Helper function to update route
const updateRoute = (lat, lng) => {
    const waypoints = [
        L.latLng(userLocation.lat, userLocation.lng),
        L.latLng(lat, lng)
    ];

    L.Routing.control({
        waypoints: waypoints,
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
        createMarker: () => null
    }).on('routesfound', function(e) {
        const route = e.routes[0];
        const routeDistance = route.summary.totalDistance / 1000;
        document.getElementById('distance').textContent = `${routeDistance.toFixed(2)} km`;
        document.getElementById('route-distance').textContent = `${routeDistance.toFixed(2)} km`;
    }).addTo(map);
};
// Hàm chuyển đổi chế độ vệ tinh
const toggleSatelliteView = () => {
    if (isSatelliteView) {
        map.removeLayer(satelliteTileLayer);
        standardTileLayer.addTo(map);
    } else {
        map.removeLayer(standardTileLayer);
        satelliteTileLayer.addTo(map);
    }
    isSatelliteView = !isSatelliteView;
};


// Hàm căn giữa bản đồ
const centerMap = () => {
    if (marker) {
        map.flyTo(marker.getLatLng(), 19, {
            animate: true,
            duration: 1.5
        });
        setTimeout(() => {
            map.invalidateSize();
        }, 500);
    }
};

// Hàm lấy vị trí người dùng
const getUserLocation = () => {
    if (navigator.geolocation) {
        const savedLocation = JSON.parse(localStorage.getItem('userLocation'));
        if (savedLocation) {
            userLocation = savedLocation;
            userMarker.setLatLng([userLocation.lat, userLocation.lng]);
            map.setView([userLocation.lat, userLocation.lng], 20);
            showNotification('Sử dụng vị trí đã lưu.');
            return;
        }

        navigator.geolocation.getCurrentPosition((position) => {
            userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            userMarker.setLatLng([userLocation.lat, userLocation.lng]);
            map.setView([userLocation.lat, userLocation.lng], 20);
            localStorage.setItem('userLocation', JSON.stringify(userLocation));
            showNotification('Vị trí đã được lưu.');
        }, (error) => {
            showNotification('Không thể lấy vị trí của bạn.');
        });
    } else {
        showNotification('Trình duyệt không hỗ trợ Geolocation.');
    }
};

// Hàm hiển thị tuyến đường
const showRoute = () => {
    if (userLocation && marker) {
        const deviceLocation = marker.getLatLng();
        if (routeLayer) {
            map.removeControl(routeLayer);
        }

        routeLayer = L.Routing.control({
            waypoints: [
                L.latLng(userLocation.lat, userLocation.lng),
                L.latLng(deviceLocation.lat, deviceLocation.lng)
            ],
            router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
            lineOptions: {
                styles: [{ color: '#007AFF', opacity: 0.7, weight: 5 }]
            },
            createMarker: () => null
        }).addTo(map);

        routeLayer.on('routesfound', (e) => {
            const route = e.routes[0];
            const distance = route.summary.totalDistance / 1000; // Khoảng cách từ OSRM (km)
            const duration = route.summary.totalTime;

            // Cập nhật route-distance và route-duration
            document.getElementById('route-distance').textContent = `${distance.toFixed(2)} km`;
            document.getElementById('distance').textContent = `${distance.toFixed(2)} km`;
            document.getElementById('route-duration').textContent = `${(duration / 60).toFixed(2)} phút`;
            const instructionsTranslation = {
                "Head": "Đi thẳng",
                "east": "hướng đông",
                "west": "hướng tây",
                "north": "hướng bắc",
                "south": "hướng nam",
                "Turn left": "Rẽ trái",
                "Turn right": "Rẽ phải",
                "Continue": "Tiếp tục",
                "at": "tại",
                "onto": "vào",
                "toward": "về phía",
                "roundabout": "vòng xuyến",
                "Exit roundabout": "Ra khỏi vòng xuyến",
                "Destination": "Điểm đến",
                "You have arrived at your destination": "Bạn đã đến nơi",
                "You have arrived": "Bạn đã đến",
                "your": "đích",
                "Make a U-turn": "Quay đầu",
                "and": "và",
                "on": "trên",
                "Take the exit": "Đi theo lối ra",
                "Keep left": "Giữ bên trái",
                "Keep right": "Giữ bên phải",
                "slightly left": "Chếch trái",
                "Slight right": "Chếch phải",
                "Merge": "Nhập vào",
                "Take the ramp": "Đi theo đường dốc",
                "In": "Trong",
                "meters": "m",
                "kilometers": "km",
                "Proceed to the route": "Đi theo lộ trình",
                "Recalculating": "Đang tính toán lại",
                "Traffic circle": "Vòng xoay",
                "Leave the traffic circle": "Ra khỏi vòng xoay",
                "Highway": "Đường cao tốc",
                "Freeway": "Xa lộ",
                "Toll road": "Đường có thu phí",
                "Bridge": "Cầu",
                "Tunnel": "Hầm",
                "Ferry": "Phà",
                "Pedestrian crossing": "Lối qua đường cho người đi bộ",
                "Speed bump": "Gờ giảm tốc",
                "Stop sign": "Biển báo dừng",
                "Enter the": "Vào",
                "Exit the": "Ra khỏi",
                "take the 1st exit": "rẽ lối ra thứ nhất",
                "take the 2nd exit": "rẽ lối ra thứ hai",
                "take the 3rd exit": "rẽ lối ra thứ ba",
                "take the 4th exit": "rẽ lối ra thứ bốn",
                "straight": "thẳng",
                "the right": "bên phải",
                "Make a sharp right": "Rẽ phải gấp",
                "Traffic light": "Đèn giao thông",
                "Turn slightly left": "Rẽ chếch trái",
                "Turn slightly right": "Rẽ chếch phải",
                "Make a sharp left": "Rẽ trái gấp",
                "Bear left": "Đi chếch trái",
                "Bear right": "Đi chếch phải",
                "Take the next left": "Rẽ trái tiếp theo",
                "Take the next right": "Rẽ phải tiếp theo",
                "Follow the signs": "Theo biển chỉ dẫn",
                "Stay on the current road": "Đi trên đường hiện tại",
                "Pass the": "Đi qua",
                "Intersection": "Ngã tư",
                "Go": 'Đi',
                "northeast": "hướng đông bắc",
                "Cross the bridge": "Qua cầu",
                "Enter the tunnel": "Vào hầm",
                "Leave the tunnel": "Ra khỏi hầm",
                "Follow the curve": "Theo đường cong",
                "Turn back": "Quay lại",
                "Take the left": "Rẽ trái",
                "Take the right": "Rẽ phải",
                "Take the left onto": "Rẽ trái vào",
                "Take the right onto": "Rẽ phải vào",
                "Take the first left": "Rẽ trái đầu tiên",
                "Take the first right": "Rẽ phải đầu tiên",
                "Take the second left": "Rẽ trái thứ hai",
                "Take the second right": "Rẽ phải thứ hai",
                "Take the third left": "Rẽ trái thứ ba",
                "Take the third right": "Rẽ phải thứ ba",
                "Take the fourth left": "Rẽ trái thứ bốn",
                "Take the fourth right": "Rẽ phải thứ bốn",
                "Take the fifth left": "Rẽ trái thứ năm",
                "Take the fifth right": "Rẽ phải thứ năm",
                "Take the sixth left": "Rẽ trái thứ sáu",
                "Take the sixth right": "Rẽ phải thứ sáu",              
                "Make a left U-turn": "Quay đầu trái",
                "Make a right U-turn": "Quay đầu phải",
                "Take the first exit": "Đi theo lối ra thứ nhất",
                "Take the second exit": "Đi theo lối ra thứ hai",
                "Take the third exit": "Đi theo lối ra thứ ba",
                "Take the fourth exit": "Đi theo lối ra thứ bốn",
                "Take the fifth exit": "Đi theo lối ra thứ năm",
                "Take the sixth exit": "Đi theo lối ra thứ sáu",
                "Take the seventh exit": "Đi theo lối ra thứ bảy",
                "Take the eighth exit": "Đi theo lối ra thứ tám",
                "Take the ninth exit": "Đi theo lối ra thứ chín",
                "Take the tenth exit": "Đi theo lối ra thứ mười"
            };
            let instructionsHTML = '<ul>';
            route.instructions.forEach((instruction, index) => {
                let text = instruction.text;
                Object.entries(instructionsTranslation).forEach(([key, value]) => {
                    text = text.replace(new RegExp(`\\b${key}\\b`, 'gi'), value);
                });
                const instructionDistance = instruction.distance;
                const distanceText = instructionDistance > 1000 
                    ? `${(instructionDistance / 1000).toFixed(2)} km` 
                    : `${instructionDistance.toFixed(2)} m`;
                instructionsHTML += `<li>Bước ${index + 1}: ${text} (${distanceText})</li>`;
            });
            document.getElementById('route-instructions').innerHTML = instructionsHTML + '</ul>';
        });
    }
};

// Hàm xóa vị trí đã lưu
const clearSavedLocation = () => {
    localStorage.removeItem('userLocation');
    userLocation = null;
    userMarker.setLatLng([0, 0]);
    showNotification('Đã xóa vị trí đã lưu.');
};

// Khởi động ứng dụng
onAuthStateChanged(auth, (user) => {
    if (!user) window.location.href = 'login.html';
    else {
        initMap();
        setInterval(updateLocation, UPDATE_INTERVAL);
        setInterval(() => {
            document.getElementById('time').textContent = new Date().toLocaleTimeString('vi-VN');
        }, 1000);
    }
});

// Xử lý sự kiện beforeunload
window.addEventListener("beforeunload", () => {
    abortController.abort();
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
});

// Gán hàm vào window object
document.getElementById('satelliteView').addEventListener('click', toggleSatelliteView);
document.getElementById('centerMap').addEventListener('click', centerMap);
document.getElementById('getLocation').addEventListener('click', getUserLocation);
document.getElementById('showRoute').addEventListener('click', function() {
    showRoute();
});
document.getElementById('clearLocation').addEventListener('click', clearSavedLocation);
document.getElementById('logout').addEventListener('click', () => {
    signOut(auth)
        .then(() => window.location.href = 'login.html')
        .catch(error => alert('Đăng xuất thất bại: ' + error.message));
        
});