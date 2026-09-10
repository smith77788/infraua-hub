/**
 * Категорія обʼєкта за його OSM-тегами.
 *
 * Дзеркалить фільтри Overpass-запитів (QUERIES) у тому ж порядку пріоритету:
 * коли один обʼєднаний запит на тайл повертає всі категорії разом, треба
 * розкласти елементи назад по категоріях. Чистий модуль — тестується без
 * серверного контексту.
 */

import type { CategoryId } from "./infra-types";
import { highestVoltage } from "./osm-tags";

export function categorize(tags: Record<string, string>): CategoryId | null {
  const re = (k: string, rx: RegExp) => tags[k] !== undefined && rx.test(tags[k]!);
  // Той самий парсер, що й скрізь: інакше запит і розкладання по категоріях
  // могли б розійтися в тому, що вважати підстанцією 110 кВ+.
  const voltageOk = () => (highestVoltage(tags["voltage"]) ?? 0) >= 110_000;
  if (tags["power"] === "plant") return "power_plant";
  if (tags["power"] === "substation" && voltageOk()) return "substation";
  if (
    (tags["man_made"] === "works" && re("product", /oil|fuel|petroleum|diesel|gas|petrol/i)) ||
    (tags["landuse"] === "depot" && re("substance", /oil|fuel|gas/i))
  )
    return "oil_gas";
  if (tags["waterway"] === "dam" && tags["name"]) return "dam";
  if (tags["man_made"] === "water_works") return "water";
  if (tags["amenity"] === "hospital") return "hospital";
  if (tags["amenity"] === "fire_station") return "fire_station";
  if (tags["aeroway"] === "aerodrome" && tags["iata"]) return "airport";
  if (tags["railway"] === "station" && tags["train"] !== "no") return "rail";
  if (tags["harbour"] === "yes" || tags["industrial"] === "port") return "seaport";
  if (tags["barrier"] === "border_control") return "border";
  if (tags["man_made"] === "communications_tower") return "telecom";
  if (tags["telecom"] === "data_center" || tags["office"] === "telecommunication")
    return "data_center";
  if (tags["office"] === "government" && tags["name"]) return "government";
  if ((tags["man_made"] === "silo" && tags["name"]) || tags["crop"] === "grain") return "grain";
  if (tags["landuse"] === "industrial" && tags["name"] && tags["operator"]) return "industry";
  return null;
}
