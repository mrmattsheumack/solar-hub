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
        "wind_speed_10m",
        "wind_gusts_10m",
      ].join(","),
      daily: [
        "sunrise",
        "sunset",
        "uv_index_max",
        "precipitation_sum",
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "wind_gusts_10m_max",
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
    const windSpeed = hourly.wind_speed_10m || [];
    const windGust = hourly.wind_gusts_10m || [];

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
      windSpeed: windSpeed[i] ?? null,   // km/h
      windGust: windGust[i] ?? null,     // km/h
    }));

    const daily = data.daily || {};
    const dailyFormatted = (daily.time || []).map((t, i) => ({
      date: t,
      sunrise: daily.sunrise?.[i],
      sunset: daily.sunset?.[i],
      uvIndexMax: daily.uv_index_max?.[i],
      precipitationSum: daily.precipitation_sum?.[i],
      weatherCode: daily.weather_code?.[i],
      tempMax: daily.temperature_2m_max?.[i],
      tempMin: daily.temperature_2m_min?.[i],
      precipProbabilityMax: daily.precipitation_probability_max?.[i],
      windGustMax: daily.wind_gusts_10m_max?.[i],
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
