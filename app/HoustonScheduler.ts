import * as moment from 'moment';
import * as _ from 'lodash';
import * as fetch from 'node-fetch';


interface PosXY {x:number,y:number}
interface PosCoords {coords: {latitude:number,longitude:number}}
interface PosArcGis {x:number,y:number, spatialReference: any}
type Position = PosXY | PosCoords;

//let locale = window.navigator.userLanguage || window.navigator.language;
//moment.locale(locale);

/**
 *
 * Handles pickup schedules for Houston.
 * TODO: Abstract to more generic schedule based system (cron?) and abstract Houston data to adapter allow easy addition of more regions
 *
 * Example "API" calls for citymap
 trash
 http://mycity.houstontx.gov/ArcGIS10/rest/services/wm/MyCityMapData_wm/MapServer/111/query?geometryType=esriGeometryPoint&f=json&outSR=102100&outFields=DAY%2CQUAD&geometry=%7B%22x%22%3A%2D10617688%2E9548%2C%22y%22%3A3467985%2E443099998%7D&spatialRel=esriSpatialRelIntersects&returnGeometry=false
 heavy/junk
 http://mycity.houstontx.gov/ArcGIS10/rest/services/wm/MyCityMapData_wm/MapServer/112/query?geometryType=esriGeometryPoint&f=json&outSR=102100&outFields=SERVICE%5FDA%2CQUAD&geometry=%7B%22x%22%3A%2D10617688%2E9548%2C%22y%22%3A3467985%2E443099998%7D&spatialRel=esriSpatialRelIntersects&returnGeometry=false
 recycling
 http://mycity.houstontx.gov/ArcGIS10/rest/services/wm/MyCityMapData_wm/MapServer/113/query?geometryType=esriGeometryPoint&f=json&outSR=102100&outFields=SERVICE%5FDAY%2CQUAD&geometry=%7B%22x%22%3A%2D10617688%2E9548%2C%22y%22%3A3467985%2E443099998%7D&spatialRel=esriSpatialRelIntersects&returnGeometry=false

 **/

interface PickupDay {wasteDay:number; junkWeekOfMonth:number; junkDay:number; recyclingDay:number; recyclingScheduleA:boolean}

export class HoustonScheduler {
  numberOfDays:number;
  pickupDays:PickupDay;
  holidays;
  events:Array<any>;
  whenLoaded:Promise<any>;
  private pos:PosArcGis;

  /**
   * Initializes the obj with event data
   * @param pos
   * @param numberOfDays
   */
  constructor(pos:Position, numberOfDays:number = 60) {
    this.numberOfDays = numberOfDays;
    //an array of moment dates that may have disrupted schedules
    this.holidays = ['2015-11-11', '2015-11-12', '2015-11-27', '2015-11-28',
      '2015-12-24', '2015-12-25', '2015-12-26',
      '2015-01-01', '2015-01-02'].map((d)=>moment(d, ' "YYYY-MM-DD"'));

    if ((<PosCoords> pos).coords) {
      this.pos = {y: (<PosCoords> pos).coords.latitude, x: (<PosCoords> pos).coords.longitude, spatialReference: {"wkid": 4326}};
    }
    else  {
      this.pos = {x: (<PosXY> pos).x, y:(<PosXY> pos).y, spatialReference: {"wkid": 4326}};
    }


    let params = {
      geometryType: 'esriGeometryPoint',
      f: "json", outSR: 102100, outFields: encodeURIComponent('DAY,QUAD,SERVICE_DA,SERVICE_DAY'),
      geometry: JSON.stringify(this.pos),
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: false
    };
    let paramStr = "?";
    Object.keys(params).forEach((key) => paramStr += "&"  + key + "=" + encodeURIComponent(params[key]));
    const mapServer = 'http://mycity.houstontx.gov/ArcGIS10/rest/services/wm/MyCityMapData_wm/MapServer/';
    const mapNumbers = [111, 112, 113]; //waste, junk and recycling
    const [wastePromise, junkPromise, recyclingPromise] = mapNumbers.map(_ => `${mapServer}${_}/query${paramStr}`)
      .map(_ => fetch(_).then(res => res.json()));

    

    this.whenLoaded = Promise.all<any>([wastePromise, junkPromise, recyclingPromise]).then((allResults)=> {
      const [wasteData, junkData, recyclingData] = allResults;
      console.log(allResults, 'all results')
      this.configure(wasteData, junkData, recyclingData);
      return this.events;
    });
  }

  configure(wasteData, junkData, recyclingData) {
    //waste is one day a week
    let wasteDay = -1;
    if (this.isValidData(wasteData)) {
      wasteDay = HoustonScheduler.getDayIndex(wasteData.features[0].attributes.DAY);
    }

    //heavy trash pickup is in the form of #rd WEEKDAY
    let junkWeekOfMonth = -1;
    let junkDay = -1;
    if (this.isValidData(junkData)) {
      let junkPattern = junkData.features[0].attributes.SERVICE_DA;
      junkWeekOfMonth = junkPattern.substr(0, 1);
      junkDay = HoustonScheduler.getDayIndex(junkPattern.substr(junkPattern.indexOf(' ')));
    }

    //recycling pickup is alternating weeks
    let recyclingDay = -1;
    let recyclingScheduleA = false;
    if (this.isValidData(recyclingData)) {
      let recyclingSchedule = recyclingData.features[0].attributes.SERVICE_DAY;
      recyclingDay = HoustonScheduler.getDayIndex(recyclingSchedule.split('-')[0]);
      //if true it is the "first week", if false it is the second week
      recyclingScheduleA = recyclingSchedule.includes('-A');
    }

    this.pickupDays = {wasteDay, junkWeekOfMonth, junkDay, recyclingDay, recyclingScheduleA};
    this.buildEvents(this.numberOfDays);
    return this.events;
  }

  isValidData(data) {
    return data && data.features && data.features.length && data.features[0].attributes;
  }

  isWasteDay(day) {
    return day.day() == this.pickupDays.wasteDay;
  }

  //used for both trash/and junk days
  isHeavyDay(day) {
    let dayInMonth = day.clone().startOf('month');
    let occurances = 0;
    while (occurances < this.pickupDays.junkWeekOfMonth) {
      if (dayInMonth.day() == this.pickupDays.junkDay) {
        occurances++;
      }
      dayInMonth.add(1, 'days');
    }
    //offset the last day added (ew)
    dayInMonth.add(-1, 'days');
    return dayInMonth.isSame(day, 'day');
  }

  isTreeDay(day) {
    return !this.isEvenMonth(day) && this.isHeavyDay(day);
  }

  isJunkDay(day) {
    return this.isEvenMonth(day) && this.isHeavyDay(day);
  }

  isEvenMonth(day) {
    return (day.month() + 1) % 2 == 0;
  }

  isRecyclingDay(day) {
    //recycling schedule A occurs every other week (starting at second week)
    let isEvenWeek = day.weeks() % 2 == 0;
    let isThisWeek = (this.pickupDays.recyclingScheduleA && isEvenWeek) || (!this.pickupDays.recyclingScheduleA && !isEvenWeek);
    return isThisWeek && day.day() == this.pickupDays.recyclingDay;
  }

  isPossibleHoliday(day) {
    return _.some(this.holidays, (d) => d.isSame(day, 'day'))
  }

  getCategoriesForDay(day) {
    let eventsForDay = {
      waste: this.isWasteDay(day),
      junk: this.isJunkDay(day),
      tree: this.isTreeDay(day),
      recycling: this.isRecyclingDay(day)
    };
    //group filter out empty days
    return _.toPairs(eventsForDay).filter((category) => category[1]).map((category)=>category[0]);
  }

  buildEvents(numberOfDays) {
    let day = moment().startOf('day');
    let groupEvents = (day)=> {
      return {
        day: day, categories: this.getCategoriesForDay(day), possibleHoliday: this.isPossibleHoliday(day)
      }
    };
    this.events = _.range(0, numberOfDays).map((i)=>day.clone().add(i, 'days')).map(groupEvents)
      .filter((event) =>event.categories.length);

  }

  static getDayIndex(dayStr) {
    return moment(dayStr, "dddd").day()
  }

}