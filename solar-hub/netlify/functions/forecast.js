// netlify/functions/forecast.js
// Fetches solar radiation + weather forecast from Open-Meteo (free, no key needed)
// Location: Dromana / Mornington Peninsula, Victoria

const LAT = -38.33;
const LON = 144.97;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const params = new URLSearchParams({
      latitude: LAT,
      longitude: LON,
      hourly: [
        "direct_radiation",
        "diffuse_radiation",
        "cloud_cover",
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
        "weather_code",
      ].join(","),
      daily: [
        "sunrise",
        "sunset",
        "uv_index_max",
        "precipitation_sum",
        "weather_code",
      ].join(","),
      timezone: "Australia/Melbourne",
      forecast_days: 7,
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const data = await res.json();

    // Calculate global horizontal irradiance (GHI = direct + diffuse)
    const hourly = data.hourly || {};
    const times = hourly.time || [];
    const directRad = hourly.direct_radiation || [];
    const diffuseRad = hourly.diffuse_radiation || [];
    const cloudCover = hourly.cloud_cover || [];
    const temp = hourly.temperature_2m || [];
    const precipProb = hourly.precipitation_probability || [];
    const precip = hourly.precipitation || [];
    const weatherCode = hourly.weather_code || [];

    const hourlyFormatted = times.map((t, i) => ({
      time: t,
      ghi: Math.round((directRad[i] || 0) + (diffuseRad[i] || 0)), // W/m²
      directRad: directRad[i] || 0,
      diffuseRad: diffuseRad[i] || 0,
      cloudCover: cloudCover[i] || 0,
      temperature: temp[i] || 0,
      precipProbability: precipProb[i] || 0,
      precipitation: precip[i] || 0,
      weatherCode: weatherCode[i] || 0,
    }));

    const daily = data.daily || {};
    const dailyFormatted = (daily.time || []).map((t, i) => ({
      date: t,
      sunrise: daily.sunrise?.[i],
      sunset: daily.sunset?.[i],
      uvIndexMax: daily.uv_index_max?.[i],
      precipitationSum: daily.precipitation_sum?.[i],
      weatherCode: daily.weather_code?.[i],
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        hourly: hourlyFormatted,
        daily: dailyFormatted,
        location: { lat: LAT, lon: LON, timezone: "Australia/Melbourne" },
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
